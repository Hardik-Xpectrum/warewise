"""Painting a bare 360° scan shape from its four photos."""

import io

import numpy as np
import trimesh
from PIL import Image

from app.glb import has_colours, load_scene
from app.paint import _yaw, paint, paint_glb

W, D, H = 0.5, 0.25, 1.7  # a box "person": wide from the front, narrow from the side
COLOURS = {"front": (220, 30, 30), "back": (30, 30, 220), "left": (30, 200, 30), "right": (230, 220, 30)}


def body() -> trimesh.Trimesh:
    box = trimesh.creation.box(extents=(W, H, D))
    box.apply_translation((0, H / 2, 0))
    verts, faces = trimesh.remesh.subdivide_to_size(box.vertices, box.faces, max_edge=0.02)
    return trimesh.Trimesh(verts, faces)


def photo(name: str) -> bytes:
    """A cut-out of the box seen from one side, one flat colour per side, 1000 px tall."""
    width = W if name in ("front", "back") else D
    px = round(900 * width / H)
    img = Image.new("RGBA", (500, 1000), (0, 0, 0, 0))
    img.paste((*COLOURS[name], 255), (250 - px // 2, 50, 250 + px // 2, 950))
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return buf.getvalue()


def views() -> dict[str, bytes]:
    return {k: photo(k) for k in COLOURS}


def side_colour(mesh: trimesh.Trimesh, normal: tuple[float, float, float]) -> np.ndarray:
    """Mean colour of the vertices in the middle of the face pointing along `normal`."""
    v = mesh.vertices
    n = np.asarray(normal)
    extent = np.abs(v @ n).max()
    on_face = np.abs(v @ n - extent) < 1e-6
    middle = (v[:, 1] > 0.3 * H) & (v[:, 1] < 0.7 * H)
    lateral = np.abs(v @ np.cross(n, (0, 1, 0))) < 0.6 * np.abs(v @ np.cross(n, (0, 1, 0))).max()
    sel = on_face & middle & lateral
    linear = mesh.visual.vertex_colors[sel, :3].mean(axis=0) / 255
    return np.where(linear <= 0.0031308, linear * 12.92, 1.055 * linear ** (1 / 2.4) - 0.055) * 255  # back to sRGB


def test_paints_each_side_from_its_photo():
    out, report = paint(body(), views())
    assert report.seen > 0.8  # the top and bottom face no camera
    assert min(report.fit.values()) > 0.8
    # Front and back are told apart only by the photos' colours here (the box is symmetric), so
    # check the sides relative to each other: opposite faces get opposite photos.
    front = side_colour(out, (0, 0, 1))
    back = side_colour(out, (0, 0, -1))
    left = side_colour(out, (1, 0, 0))
    right = side_colour(out, (-1, 0, 0))
    got = {name: min(COLOURS, key=lambda k: np.linalg.norm(np.asarray(COLOURS[k]) - c)) for name, c in (("front", front), ("back", back), ("left", left), ("right", right))}
    assert got == {"front": "front", "back": "back", "left": "left", "right": "right"} or got == {
        "front": "back",
        "back": "front",
        "left": "right",
        "right": "left",
    }
    for name, c in (("front", front), ("back", back), ("left", left), ("right", right)):
        assert np.linalg.norm(np.asarray(COLOURS[got[name]]) - c) < 25


def test_turns_a_sideways_model_to_face_the_camera():
    sideways = body()
    sideways.apply_transform(_yaw(1))  # now wide along z: the front faces +x
    out, report = paint(sideways, views())
    assert report.quarters in (1, 3)
    ext = out.extents
    assert ext[0] > ext[2]  # wide side across x again, facing +z


def test_glb_round_trip_keeps_the_colours():
    glb = bytes(body().export(file_type="glb"))
    painted, _ = paint_glb(glb, views())
    assert has_colours(painted)
    assert not has_colours(glb)
    load_scene(painted)  # still a valid model
