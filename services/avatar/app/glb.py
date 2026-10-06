"""GLB (binary glTF 2.0) checks and normalisation.

Engines return files from servers we don't control, so every model is checked before it is
stored: size cap, glTF magic and version, a JSON chunk, and that trimesh can load real geometry
from it. Then the mesh is normalised for the web viewer: scaled so it is as tall as the user,
feet on y = 0, centred on x and z, with the node transforms baked into the vertices (so the
accessors' min/max are the true bounds for anyone reading the file without a scene graph).
"""

from __future__ import annotations

import io
import json
import struct
from dataclasses import dataclass

import numpy as np
import trimesh
from PIL import Image

MAX_GLB_BYTES = 50 * 1024 * 1024


class BadModel(ValueError):
    """The file isn't a usable GLB model."""


def is_glb(buf: bytes) -> bool:
    """A GLB starts with the ASCII magic "glTF" and version 2."""
    return len(buf) > 20 and buf[:4] == b"glTF" and struct.unpack_from("<I", buf, 4)[0] == 2


def glb_json(buf: bytes) -> dict | None:
    """The glTF JSON chunk (the first chunk of a GLB), or None when the file is malformed."""
    if not is_glb(buf):
        return None
    length = struct.unpack_from("<I", buf, 12)[0]
    if buf[16:20] != b"JSON" or 20 + length > len(buf):
        return None
    try:
        out = json.loads(buf[20 : 20 + length].decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    return out if isinstance(out, dict) else None


def has_texture(buf: bytes) -> bool:
    """Whether the model carries at least one image (a painted texture)."""
    j = glb_json(buf)
    return bool(j and j.get("images"))


def has_colours(buf: bytes) -> bool:
    """Whether the model is painted per vertex (COLOR_0), as a painted 360° scan is."""
    j = glb_json(buf)
    return bool(j) and any("COLOR_0" in (p.get("attributes") or {}) for m in j.get("meshes") or [] for p in m.get("primitives") or [])


def assert_glb(buf: bytes, what: str = "Engine") -> bytes:
    """Raises BadModel unless `buf` is a GLB of acceptable size."""
    if len(buf) > MAX_GLB_BYTES:
        raise BadModel(f"Model is too large ({round(len(buf) / 1e6)} MB)")
    if not is_glb(buf) or glb_json(buf) is None:
        raise BadModel(f"{what} returned something that isn't a GLB model")
    return buf


def load_scene(buf: bytes, what: str = "Engine") -> trimesh.Scene:
    """Loads a checked GLB with trimesh; raises BadModel when it holds no triangles."""
    assert_glb(buf, what)
    try:
        scene = trimesh.load(io.BytesIO(buf), file_type="glb", force="scene")
    except Exception as err:  # noqa: BLE001 - trimesh raises many kinds on broken files
        raise BadModel(f"{what} returned a GLB that can't be read ({type(err).__name__})") from err
    meshes = [g for g in scene.geometry.values() if isinstance(g, trimesh.Trimesh) and len(g.faces)]
    if not meshes:
        raise BadModel(f"{what} returned a GLB without a mesh")
    return scene


@dataclass
class GlbInfo:
    bytes: int
    textured: bool
    meshes: int
    faces: int
    height: float  # bounding height (y extent) in the model's own units
    extents: tuple[float, float, float]

    def as_log(self) -> dict:
        return {
            "bytes": self.bytes,
            "textured": self.textured,
            "meshes": self.meshes,
            "faces": self.faces,
            "height": round(self.height, 4),
            "extents": [round(e, 4) for e in self.extents],
        }


def glb_info(buf: bytes, scene: trimesh.Scene | None = None) -> GlbInfo:
    scene = scene or load_scene(buf)
    ext = scene.extents
    faces = sum(len(g.faces) for g in scene.geometry.values() if isinstance(g, trimesh.Trimesh))
    return GlbInfo(len(buf), has_texture(buf), len(scene.geometry), faces, float(ext[1]), (float(ext[0]), float(ext[1]), float(ext[2])))


def _baked(scene: trimesh.Scene) -> trimesh.Scene:
    """A flat scene: every instance's world transform applied to a copy of its mesh."""
    out = trimesh.Scene()
    for node in scene.graph.nodes_geometry:
        transform, name = scene.graph[node]
        geom = scene.geometry[name]
        if not isinstance(geom, trimesh.Trimesh):
            continue
        out.add_geometry(geom.copy().apply_transform(transform), geom_name=name, node_name=node)
    return out


def normalise(buf: bytes, height_m: float, what: str = "Engine") -> tuple[bytes, GlbInfo, GlbInfo]:
    """Scales the model to `height_m` (y up, as glTF), puts its lowest point on y = 0 and centres
    it on x and z. Returns (new GLB, info before, info after)."""
    scene = load_scene(buf, what)
    before = glb_info(buf, scene)
    if before.height <= 0:
        raise BadModel(f"{what} returned a flat model")
    flat = _baked(scene)
    lo, hi = flat.bounds
    s = height_m / float(hi[1] - lo[1])
    centre = (lo + hi) / 2
    m = np.eye(4)
    m[:3, :3] *= s
    m[:3, 3] = [-centre[0] * s, -lo[1] * s, -centre[2] * s]
    for geom in flat.geometry.values():
        geom.apply_transform(m)
    out = flat.export(file_type="glb")
    out = assert_glb(bytes(out), "Normalising")
    after = glb_info(out)
    if (before.textured and not after.textured) or (has_colours(buf) and not has_colours(out)):
        raise BadModel("Normalising lost the model's texture")
    return out, before, after


def bounds(buf: bytes) -> np.ndarray:
    return load_scene(buf).bounds


def with_texture(buf: bytes, texture: Image.Image, what: str = "The face scan") -> bytes:
    """The face mesh with `texture` as its base colour, when the mesh has UVs (MediaPipe's
    canonical face mesh does). Returns the file unchanged when it has no UVs."""
    scene = load_scene(buf, what)
    changed = False
    for geom in scene.geometry.values():
        uv = getattr(geom.visual, "uv", None)
        if isinstance(geom, trimesh.Trimesh) and uv is not None and len(uv) == len(geom.vertices):
            material = trimesh.visual.material.PBRMaterial(baseColorTexture=texture, metallicFactor=0.0, roughnessFactor=0.9)
            geom.visual = trimesh.visual.TextureVisuals(uv=uv, material=material)
            changed = True
    if not changed:
        return buf
    return assert_glb(bytes(scene.export(file_type="glb")), what)


def mock_glb() -> bytes:
    """A tiny valid GLB (a 0.5 x 1.7 x 0.3 m box, roughly a person's bounds) for the mock engine,
    so tests and offline development exercise the whole pipeline without spending GPU quota.
    Byte-for-byte the same as the TypeScript service's mockGlb."""
    w, h, d = 0.25, 1.7, 0.15
    p = [(-w, 0, -d), (w, 0, -d), (w, h, -d), (-w, h, -d), (-w, 0, d), (w, 0, d), (w, h, d), (-w, h, d)]
    idx = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5]
    pos = b"".join(struct.pack("<3f", *v) for v in p)
    ind = struct.pack(f"<{len(idx)}H", *idx)
    bin_ = pos + ind
    gltf = {
        "asset": {"version": "2.0", "generator": "warewise-mock"},
        "buffers": [{"byteLength": len(bin_)}],
        "bufferViews": [
            {"buffer": 0, "byteOffset": 0, "byteLength": len(pos), "target": 34962},
            {"buffer": 0, "byteOffset": len(pos), "byteLength": len(ind), "target": 34963},
        ],
        "accessors": [
            {"bufferView": 0, "componentType": 5126, "count": len(p), "type": "VEC3", "min": [-w, 0, -d], "max": [w, h, d]},
            {"bufferView": 1, "componentType": 5123, "count": len(idx), "type": "SCALAR"},
        ],
        "materials": [{"pbrMetallicRoughness": {"baseColorFactor": [0.8, 0.75, 0.7, 1], "metallicFactor": 0, "roughnessFactor": 0.9}}],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0}, "indices": 1, "material": 0}]}],
        "nodes": [{"mesh": 0}],
        "scenes": [{"nodes": [0]}],
        "scene": 0,
    }

    def pad(b: bytes, fill: bytes) -> bytes:
        return b + fill * ((4 - len(b) % 4) % 4)

    json_chunk = pad(json.dumps(gltf, separators=(",", ":")).encode(), b" ")
    bin_chunk = pad(bin_, b"\0")
    total = 12 + 8 + len(json_chunk) + 8 + len(bin_chunk)
    return (
        b"glTF"
        + struct.pack("<II", 2, total)
        + struct.pack("<I", len(json_chunk)) + b"JSON" + json_chunk
        + struct.pack("<I", len(bin_chunk)) + b"BIN\0" + bin_chunk
    )
