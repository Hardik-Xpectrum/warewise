"""Paints a 360° scan's four photos onto the engine's bare body shape.

Hunyuan3D-2mv makes a good shape from the four views but its own texturing is broken upstream,
so the model comes back grey. The views are cut-outs taken from the front, both sides and the
back, which is enough to colour the whole body ourselves:

1. Find which way the model faces: of the four quarter turns, the one whose outlines (seen from
   front, left, back and right) best match the photos' outlines. The model is turned to face +z,
   the glTF convention, so the viewer shows the front first.
2. Line each photo up with the model's outline from that side (scale and shift, searched).
3. Colour every vertex from the photos that see it: front-facing surfaces count most, hidden
   ones (behind an arm, say) not at all, and pixels near the outline (where the cut-out blends
   into the background) are skipped. The head is coloured from the front and back only (people
   look at the phone while turning). Spots no photo sees take their neighbours' colour.

Orthographic projection is close enough at a 2–3 m scan distance. Pure numpy; no GPU.
"""

from __future__ import annotations

import io
from dataclasses import dataclass

import numpy as np
import trimesh
from PIL import Image, ImageFilter

VIEWS = ("front", "left", "back", "right")
MASK_H = 160  # outline matching resolution (pixels tall)
DEPTH_H = 220  # visibility test resolution
HEAD = 0.12  # top share of the height that is the head (shifted as one)
NECK = 0.18  # where the head's own shift has faded out
SHARPNESS = 10  # how strongly the squarest camera wins where two photos see the same spot
DEPTH_TOLERANCE = 0.025  # of the body's height: how far behind the nearest surface still counts as seen


@dataclass(frozen=True)
class Camera:
    toward: np.ndarray  # unit vector from the body to the camera (model faces +z)
    right: np.ndarray  # the image's x axis


# The person faces +z. Their left side is +x (seen from the front, their left is the image's right).
CAMERAS = {
    "front": Camera(np.array([0.0, 0.0, 1.0]), np.array([1.0, 0.0, 0.0])),
    "left": Camera(np.array([1.0, 0.0, 0.0]), np.array([0.0, 0.0, -1.0])),
    "back": Camera(np.array([0.0, 0.0, -1.0]), np.array([-1.0, 0.0, 0.0])),
    "right": Camera(np.array([-1.0, 0.0, 0.0]), np.array([0.0, 0.0, 1.0])),
}


def _yaw(quarters: int) -> np.ndarray:
    a = quarters * np.pi / 2
    c, s = round(np.cos(a)), round(np.sin(a))
    m = np.eye(4)
    m[0, 0], m[0, 2], m[2, 0], m[2, 2] = c, s, -s, c
    return m


def _open(png: bytes) -> Image.Image:
    return Image.open(io.BytesIO(png)).convert("RGBA")


def _bbox(alpha: np.ndarray) -> tuple[int, int, int, int] | None:
    ys, xs = np.nonzero(alpha > 127)
    if not len(ys):
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1


def _project(verts: np.ndarray, cam: Camera) -> tuple[np.ndarray, np.ndarray]:
    """(u, y) in model units, and depth toward the camera."""
    return np.stack([verts @ cam.right, verts[:, 1]], axis=1), verts @ cam.toward


@dataclass
class _Fit:
    scale: float  # image pixels per model unit
    ox: float  # image x of u = 0
    oy: float  # image y of y = 0

    def pixels(self, uv: np.ndarray) -> np.ndarray:
        return np.stack([self.ox + uv[:, 0] * self.scale, self.oy - uv[:, 1] * self.scale], axis=1)


def _silhouette(px: np.ndarray, w: int, h: int) -> np.ndarray:
    """The mesh's outline at image size (w, h): its vertices splatted, then closed up (the
    vertices are about a pixel apart at this size)."""
    xi, yi = px[:, 0].astype(int), px[:, 1].astype(int)
    keep = (xi >= 0) & (xi < w) & (yi >= 0) & (yi < h)
    grid = np.zeros((h, w), np.uint8)
    grid[yi[keep], xi[keep]] = 255
    img = Image.fromarray(grid).filter(ImageFilter.MaxFilter(3)).filter(ImageFilter.MinFilter(3))
    return np.asarray(img) > 0


def _iou(a: np.ndarray, b: np.ndarray) -> float:
    union = np.logical_or(a, b).sum()
    return float(np.logical_and(a, b).sum() / union) if union else 0.0


def _fit(uv: np.ndarray, alpha: np.ndarray, search: bool) -> tuple[_Fit, float]:
    """Lines the model's outline up with the photo's: first by bounding boxes (heads at the top,
    centres together, heights equal), then by a small search over scale and shift."""
    h, w = alpha.shape
    box = _bbox(alpha)
    if box is None:
        raise ValueError("empty view")
    x0, y0, x1, y1 = box
    umin, umax = uv[:, 0].min(), uv[:, 0].max()
    ymin, ymax = uv[:, 1].min(), uv[:, 1].max()
    # Feet are often cut by the frame's bottom edge, so heads are lined up, not feet.
    base = _Fit(scale=(y1 - y0) / (ymax - ymin), ox=0.0, oy=0.0)
    base.ox = (x0 + x1) / 2 - (umin + umax) / 2 * base.scale
    base.oy = y0 + ymax * base.scale
    k = MASK_H / h
    small = np.asarray(Image.fromarray((alpha > 127).astype(np.uint8) * 255).resize((max(1, round(w * k)), MASK_H))) > 127
    if not search:
        return base, _iou(_silhouette(base.pixels(uv) * k, small.shape[1], small.shape[0]), small)
    best, best_iou = base, -1.0
    for ds in (0.94, 0.97, 1.0, 1.03, 1.06):
        for dx in (-0.03, 0.0, 0.03):
            for dy in (-0.03, 0.0, 0.03):
                f = _Fit(base.scale * ds, base.ox + dx * (y1 - y0), base.oy + dy * (y1 - y0))
                f.ox += ((x0 + x1) / 2 - f.ox) * (1 - ds)  # scale about the box centre
                f.oy += (y0 - f.oy) * (1 - ds)  # and about the head
                sil = _silhouette(f.pixels(uv) * k, small.shape[1], small.shape[0])
                score = _iou(sil, small)
                if score > best_iou:
                    best, best_iou = f, score
    return best, best_iou


def _headness(uv: np.ndarray) -> np.ndarray:
    """1 on the head, fading to 0 down the neck."""
    from_top = (uv[:, 1].max() - uv[:, 1]) / (uv[:, 1].max() - uv[:, 1].min())
    return np.clip((NECK - from_top) / (NECK - HEAD), 0, 1)


def _head_shift(uv: np.ndarray, px: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    """Per-vertex sideways shift that lines the head up on its own. People tilt and turn their
    head a little between views, so after the whole-body fit the head can sit a few pixels off,
    which paints a second face beside the profile. Returns pixels to add to each vertex's x:
    the full shift on the head, fading out down the neck."""
    ymin, ymax = uv[:, 1].min(), uv[:, 1].max()
    tall = ymax - ymin
    from_top = (ymax - uv[:, 1]) / tall
    head = from_top < HEAD
    if head.sum() < 50:
        return np.zeros(len(uv))
    top, bottom = px[head, 1].min(), px[head, 1].max()
    rows = alpha[int(max(0, top)) : int(min(alpha.shape[0], bottom))] > 127
    ys, xs = np.nonzero(rows)
    if not len(xs):
        return np.zeros(len(uv))
    # Mesh outline of the head band, at full resolution of the band.
    w = alpha.shape[1]
    sil = _silhouette(px[head] - [0, top], w, rows.shape[0])
    _, mx = np.nonzero(sil)
    if not len(mx):
        return np.zeros(len(uv))
    dx = float(xs.mean() - mx.mean())
    dx = float(np.clip(dx, -0.05 * w, 0.05 * w))
    return dx * _headness(uv)


def _visible(px: np.ndarray, depth: np.ndarray, w: int, h: int, height_units: float, scale: float) -> np.ndarray:
    """Which vertices are the nearest surface to the camera at their pixel (a splatted depth map,
    widened by a pixel so gaps between vertices don't let hidden ones through)."""
    k = DEPTH_H / h
    gw, gh = max(1, round(w * k)), DEPTH_H
    gx = np.clip((px[:, 0] * k).astype(int), 0, gw - 1)
    gy = np.clip((px[:, 1] * k).astype(int), 0, gh - 1)
    near = np.full((gh, gw), -np.inf)
    np.maximum.at(near, (gy, gx), depth)
    padded = np.pad(near, 1, constant_values=-np.inf)
    wide = np.max([padded[1 + dy : 1 + dy + gh, 1 + dx : 1 + dx + gw] for dy in (-1, 0, 1) for dx in (-1, 0, 1)], axis=0)
    return depth >= wide[gy, gx] - DEPTH_TOLERANCE * height_units


def _to_linear(c: np.ndarray) -> np.ndarray:
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def _vertex_normals(verts: np.ndarray, faces: np.ndarray) -> np.ndarray:
    """Area-weighted vertex normals (trimesh's own need scipy, which this service doesn't ship)."""
    tri = verts[faces]
    fn = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])  # length = twice the area
    vn = np.zeros_like(verts)
    for i in range(3):
        np.add.at(vn, faces[:, i], fn)
    return vn / np.maximum(np.linalg.norm(vn, axis=1, keepdims=True), 1e-12)


def _fill_unseen(mesh: trimesh.Trimesh, colours: np.ndarray, seen: np.ndarray, rounds: int = 60) -> np.ndarray:
    """Spreads colour into vertices no photo saw (top of the head, under the arms) from their
    neighbours, a ring at a time."""
    out = colours.copy()
    known = seen.copy()
    edges = mesh.edges_unique
    for _ in range(rounds):
        if known.all():
            break
        a, b = edges[:, 0], edges[:, 1]
        acc = np.zeros_like(out)
        cnt = np.zeros(len(out))
        for s, t in ((a, b), (b, a)):
            m = known[s] & ~known[t]
            np.add.at(acc, t[m], out[s[m]])
            np.add.at(cnt, t[m], 1)
        new = cnt > 0
        out[new] = acc[new] / cnt[new, None]
        known |= new
    if not known.all():
        out[~known] = out[known].mean(axis=0) if known.any() else 0.6
    return out


@dataclass
class PaintReport:
    quarters: int  # quarter turns applied to face +z
    fit: dict[str, float]  # outline match (0..1) per view
    seen: float  # share of vertices some photo saw

    def as_log(self) -> dict:
        return {"quarters": self.quarters, "fit": {k: round(v, 3) for k, v in self.fit.items()}, "seen": round(self.seen, 3)}


def paint(mesh: trimesh.Trimesh, views: dict[str, bytes]) -> tuple[trimesh.Trimesh, PaintReport]:
    """Returns a copy of `mesh` turned to face +z and coloured per vertex from `views` (cut-out
    PNGs named front / left / back / right; at least the front and one more)."""
    images = {k: _open(v) for k, v in views.items() if v and k in CAMERAS}
    if "front" not in images or len(images) < 2:
        raise ValueError("painting needs the front view and at least one other")
    alphas = {k: np.asarray(im)[:, :, 3] for k, im in images.items()}

    # 1. Which way the model faces: the quarter turn whose outlines match best.
    best_q, best_score = 0, -1.0
    for q in range(4):
        verts = trimesh.transform_points(mesh.vertices, _yaw(q))
        score = 0.0
        for name, alpha in alphas.items():
            uv, _ = _project(verts, CAMERAS[name])
            _, s = _fit(uv, alpha, search=False)
            score += s
        if score > best_score:
            best_q, best_score = q, score
    out = mesh.copy()
    out.apply_transform(_yaw(best_q))
    verts = out.vertices
    normals = _vertex_normals(verts, out.faces)
    height_units = float(verts[:, 1].max() - verts[:, 1].min())

    # 2–3. Colour from each photo that sees the vertex.
    acc = np.zeros((len(verts), 3))
    weight = np.zeros(len(verts))
    seen = np.zeros(len(verts), bool)
    fits: dict[str, float] = {}
    for name, image in images.items():
        cam = CAMERAS[name]
        rgba = np.asarray(image).astype(np.float64)
        alpha = alphas[name]
        h, w = alpha.shape
        uv, depth = _project(verts, cam)
        fit, score = _fit(uv, alpha, search=True)
        fits[name] = score
        px = fit.pixels(uv)
        px[:, 0] += _head_shift(uv, px, alpha)
        facing = np.clip(normals @ cam.toward, 0, 1)
        vis = _visible(px, depth, w, h, height_units, fit.scale)
        # Stay away from the outline, where the cut-out fades into the old background.
        solid = np.asarray(Image.fromarray(alpha).filter(ImageFilter.MinFilter(9)))
        xi = np.clip(px[:, 0].round().astype(int), 0, w - 1)
        yi = np.clip(px[:, 1].round().astype(int), 0, h - 1)
        inside = (px[:, 0] >= 0) & (px[:, 0] < w) & (px[:, 1] >= 0) & (px[:, 1] < h) & (solid[yi, xi] > 200)
        # A steep power: each spot takes its colour almost only from the camera facing it most
        # squarely, so the face from the front photo doesn't ghost over the side photo's profile.
        wgt = np.where(vis & inside, facing**SHARPNESS, 0.0)
        if name in ("left", "right"):
            # People look at the phone as they turn, so the side photos show the face three-quarter
            # on, not in profile: the head takes its colour from the front and back photos only.
            wgt *= 1 - _headness(uv)
        acc += rgba[yi, xi, :3] * wgt[:, None]
        weight += wgt
        seen |= (wgt > 0) & (facing > 0.1)
    seen &= weight > 0
    colours = np.zeros((len(verts), 3))
    colours[seen] = acc[seen] / weight[seen, None]
    colours = _fill_unseen(out, colours, seen)
    # glTF vertex colours are linear; photo pixels are sRGB.
    linear = _to_linear(np.clip(colours, 0, 255) / 255) * 255
    rgba = np.concatenate([linear, np.full((len(verts), 1), 255.0)], axis=1).round().astype(np.uint8)
    out.visual = trimesh.visual.ColorVisuals(out, vertex_colors=rgba)
    return out, PaintReport(best_q, fits, float(seen.mean()))


def paint_glb(buf: bytes, views: dict[str, bytes]) -> tuple[bytes, PaintReport]:
    """`paint` for a GLB file: its meshes joined into one, painted, and written back as a GLB."""
    from .glb import assert_glb, load_scene

    scene = load_scene(buf, "The 3D service")
    mesh = scene.to_geometry()
    if not isinstance(mesh, trimesh.Trimesh):
        raise ValueError("no mesh to paint")
    painted, report = paint(mesh, views)
    return assert_glb(bytes(painted.export(file_type="glb")), "Painting"), report
