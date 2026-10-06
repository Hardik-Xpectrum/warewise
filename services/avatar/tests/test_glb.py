import struct

import numpy as np
import pytest
import trimesh
from PIL import Image

from app.glb import MAX_GLB_BYTES, BadModel, assert_glb, glb_info, glb_json, has_texture, is_glb, load_scene, mock_glb, normalise, with_texture


def test_mock_is_valid_glb():
    glb = mock_glb()
    assert is_glb(glb)
    assert struct.unpack_from("<I", glb, 8)[0] == len(glb)
    assert not is_glb(b"<html>not a model</html>")


def test_rejects_v1_and_truncated():
    v1 = bytearray(mock_glb())
    struct.pack_into("<I", v1, 4, 1)
    assert not is_glb(bytes(v1))
    assert not is_glb(mock_glb()[:12])


def test_json_chunk_bounds_and_texture():
    assert glb_json(mock_glb())["asset"] == {"version": "2.0", "generator": "warewise-mock"}
    info = glb_info(mock_glb())
    assert not info.textured and info.meshes == 1 and info.faces == 12
    assert info.height == pytest.approx(1.7)
    assert glb_json(b"nope") is None


def test_assert_glb():
    with pytest.raises(BadModel, match="Space returned something that isn't a GLB model"):
        assert_glb(b"<html>502</html>", "Space")
    with pytest.raises(BadModel, match="too large"):
        assert_glb(b"glTF" + bytes(MAX_GLB_BYTES))
    assert assert_glb(mock_glb()) == mock_glb()


def test_load_rejects_glb_without_mesh():
    pc = trimesh.Scene(trimesh.PointCloud(np.random.rand(10, 3))).export(file_type="glb")
    with pytest.raises(BadModel, match="without a mesh"):
        load_scene(pc)


def textured_box() -> bytes:
    box = trimesh.creation.box(extents=(0.4, 2.0, 0.3))
    box.apply_translation((3, 5, -1))  # off-centre, floating
    uv = np.random.default_rng(1).random((len(box.vertices), 2))
    tex = Image.new("RGB", (8, 8), (200, 100, 50))
    box.visual = trimesh.visual.TextureVisuals(uv=uv, material=trimesh.visual.material.PBRMaterial(baseColorTexture=tex))
    return bytes(trimesh.Scene(box).export(file_type="glb"))


def test_normalise_scales_to_height_feet_on_floor_centred_and_keeps_texture():
    src = textured_box()
    assert has_texture(src)
    out, before, after = normalise(src, 1.75)
    assert before.height == pytest.approx(2.0) and after.height == pytest.approx(1.75)
    lo, hi = load_scene(out).bounds
    assert lo[1] == pytest.approx(0, abs=1e-6)
    assert (lo[0] + hi[0]) / 2 == pytest.approx(0, abs=1e-6) and (lo[2] + hi[2]) / 2 == pytest.approx(0, abs=1e-6)
    assert after.textured and has_texture(out)
    # Transforms are baked into the vertices: the POSITION accessor's bounds are the real ones.
    acc = [a for a in glb_json(out)["accessors"] if a.get("type") == "VEC3" and "max" in a][0]
    assert acc["max"][1] - acc["min"][1] == pytest.approx(1.75, abs=1e-4)


def test_normalise_node_transforms():
    # A model whose height comes from a node scale is measured in world space.
    scene = trimesh.Scene()
    scene.add_geometry(trimesh.creation.box(extents=(1, 1, 1)), transform=np.diag([1, 3, 1, 1]))
    out, before, _ = normalise(bytes(scene.export(file_type="glb")), 1.6)
    assert before.height == pytest.approx(3)
    assert load_scene(out).extents[1] == pytest.approx(1.6)


def test_face_texture_is_embedded_when_the_mesh_has_uvs():
    face = trimesh.creation.icosphere(subdivisions=1, radius=0.1)
    face.visual = trimesh.visual.TextureVisuals(uv=np.random.default_rng(2).random((len(face.vertices), 2)))
    glb = bytes(trimesh.Scene(face).export(file_type="glb"))
    out = with_texture(glb, Image.new("RGB", (16, 16), (220, 180, 160)))
    assert has_texture(out)
    mat = next(iter(load_scene(out).geometry.values())).visual.material
    assert mat.baseColorTexture.size == (16, 16)
    assert mat.baseColorTexture.convert("RGB").getpixel((3, 3)) == (220, 180, 160)
    no_uv = with_texture(mock_glb(), Image.new("RGB", (4, 4)))
    assert no_uv == mock_glb()


def test_mock_matches_typescript_bytes():
    import hashlib

    # sha256 of mockGlb() from services/avatar-ts/src/glb.ts
    assert hashlib.sha256(mock_glb()).hexdigest() == "89062000656f27037050821d1fa6979305dd92261918fad5174d865a236c0b7e"
