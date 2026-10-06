"""Textures for the 3D avatar from a 2D render.

Front: the render with its white background keyed out. The key is a flood fill from the image
border over near-white pixels (OpenCV connected components, 4-connected), so white clothes inside
the figure stay (a plain colour key would punch holes in a white shirt). Pixels on the edge of the
keyed area get a soft alpha from how white they are, which hides the light halo the try-on models
leave around the body.

Back: the models only ever see the front, so the back is a plain stand-in: the front's colours
averaged down to a coarse 12 x 16 grid (each cell the mean colour of the body/garment under it,
background cells filled with the overall mean so no white bleeds in), scaled back up smoothly,
blurred, mirrored left-right (the back view swaps sides) and cut to the front's mirrored
silhouette. No face, print or logo survives, only the broad garment colours per region.

Images here are numpy arrays of shape (height, width, 4), dtype uint8 (RGBA).
"""

from __future__ import annotations

import cv2
import numpy as np
from PIL import Image

from app.images import encode, open_image


def _near_white(rgb: np.ndarray) -> np.ndarray:
    lo = rgb.min(axis=2).astype(np.int16)
    hi = rgb.max(axis=2).astype(np.int16)
    return (lo >= 247) & (hi - lo <= 8)


def key_out_background(img: np.ndarray) -> np.ndarray:
    """Makes the border-connected white background transparent. Returns a new RGBA array."""
    out = img.copy()
    candidate = (out[..., 3] < 8) | _near_white(out[..., :3])
    _, labels = cv2.connectedComponents(candidate.astype(np.uint8), connectivity=4)
    border = np.concatenate([labels[0, :], labels[-1, :], labels[:, 0], labels[:, -1]])
    border_cand = np.concatenate([candidate[0, :], candidate[-1, :], candidate[:, 0], candidate[:, -1]])
    seeds = np.unique(border[border_cand])
    bg = np.isin(labels, seeds) & candidate

    # Soft edge: a light pixel touching the background is partly transparent.
    touches = np.zeros_like(bg)
    touches[:, 1:] |= bg[:, :-1]
    touches[:, :-1] |= bg[:, 1:]
    touches[1:, :] |= bg[:-1, :]
    touches[:-1, :] |= bg[1:, :]
    lo = out[..., :3].min(axis=2).astype(np.float64)
    soft = touches & ~bg & (lo > 200)
    factor = np.minimum(1.0, (255.0 - lo) / 55.0)
    alpha = out[..., 3].astype(np.float64)
    alpha = np.where(soft, np.floor(alpha * factor + 0.5), alpha)
    alpha[bg] = 0
    out[..., 3] = alpha.astype(np.uint8)
    return out


def average_grid(img: np.ndarray, cols: int, rows: int) -> np.ndarray:
    """Mean colour of each cell's opaque pixels (alpha-weighted); thin or empty cells get the
    overall mean. Returns a (rows, cols, 4) opaque RGBA array. Pure."""
    h, w = img.shape[:2]
    cy = np.minimum(rows - 1, (np.arange(h) * rows) // h)
    cx = np.minimum(cols - 1, (np.arange(w) * cols) // w)
    cell = (cy[:, None] * cols + cx[None, :]).ravel()
    a = img[..., 3].astype(np.float64).ravel() / 255.0
    n = cols * rows
    weight = np.bincount(cell, weights=a, minlength=n)
    sums = [np.bincount(cell, weights=img[..., k].astype(np.float64).ravel() * a, minlength=n) for k in range(3)]
    total_w = weight.sum()
    mean = [s.sum() / total_w for s in sums] if total_w > 0 else [128.0, 128.0, 128.0]
    cell_area = (w / cols) * (h / rows)
    # A cell with only a sliver of body would take a noisy colour from its edge: use the mean.
    solid = weight > cell_area * 0.15
    out = np.empty((n, 4), dtype=np.uint8)
    for k in range(3):
        values = np.where(solid, sums[k] / np.where(solid, weight, 1.0), mean[k])
        out[:, k] = np.floor(values + 0.5).astype(np.uint8)
    out[:, 3] = 255
    return out.reshape(rows, cols, 4)


def to_rgba(data: bytes) -> np.ndarray:
    return np.array(open_image(data).convert("RGBA"))


def png(img: np.ndarray) -> bytes:
    return encode(Image.fromarray(img, "RGBA"), "PNG")


def avatar_textures(render: bytes) -> tuple[bytes, bytes]:
    """Front and back textures (PNG with alpha) for the 3D avatar from a render on white."""
    front = key_out_background(to_rgba(render))
    h, w = front.shape[:2]
    grid = average_grid(front, 12, 16)
    smooth = cv2.resize(grid, (w, h), interpolation=cv2.INTER_CUBIC)
    smooth = cv2.GaussianBlur(smooth, (0, 0), sigmaX=max(4.0, w / 40))
    back = np.ascontiguousarray(smooth[:, ::-1])
    back[..., 3] = front[:, ::-1, 3]
    return png(front), png(back)
