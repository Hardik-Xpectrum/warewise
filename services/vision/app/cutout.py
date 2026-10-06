"""Plain-background keyer: the cut-out fallback when the clothes parser can't separate the garment."""

from __future__ import annotations

import numpy as np
from scipy import ndimage

THRESHOLD = 42.0
_FOUR = ndimage.generate_binary_structure(2, 1)  # 4-connected, like the TypeScript flood fill


def key_out_background(rgba: np.ndarray) -> np.ndarray | None:
    """Removes a plain background from an (H, W, 4) uint8 garment photo.

    Samples the border colour, then flood-fills from the edges through pixels close to it.
    Returns a new RGBA array, or None when the background is too busy to key out reliably.
    """
    h, w = rgba.shape[:2]
    alpha = rgba[..., 3]
    # Already transparent at the corners (e.g. removed in the browser): nothing to do.
    if all(alpha[y, x] < 16 for y, x in ((0, 0), (0, w - 1), (h - 1, 0), (h - 1, w - 1))):
        return rgba.copy()

    rgb = rgba[..., :3].astype(np.float64)
    # Background estimate: per-channel (upper) median of border pixels, sampled every `step`.
    step = max(1, (w + h) // 400)
    border: list[np.ndarray] = []
    for x in range(0, w, step):
        border += [rgb[0, x], rgb[h - 1, x]]
    for y in range(0, h, step):
        border += [rgb[y, 0], rgb[y, w - 1]]
    samples = np.array(border)
    bg = np.sort(samples, axis=0)[len(samples) >> 1]

    near_border = np.sqrt(((samples - bg) ** 2).sum(-1)) < THRESHOLD
    if near_border.mean() < 0.7:
        return None  # busy background

    near = np.sqrt(((rgb - bg) ** 2).sum(-1)) < THRESHOLD
    labels, _ = ndimage.label(near, structure=_FOUR)
    edge_labels = np.unique(np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]]))
    edge_labels = edge_labels[edge_labels > 0]
    is_bg = np.isin(labels, edge_labels)

    # Quality guard: after keying, the photo's edge should be almost all background. If much of it
    # survives (a textured wall, a floor), the "cut-out" would carry that background along. Corners
    # count twice, as in the TypeScript version.
    edge = np.concatenate([is_bg[0], is_bg[-1], is_bg[:, 0], is_bg[:, -1]])
    if (~edge).sum() / edge.size > 0.12:
        return None

    out = rgba.copy()
    out[..., 3] = np.where(is_bg, 0, out[..., 3])
    # Soften the edge: a foreground pixel touching background gets partial alpha.
    padded = np.pad(is_bg, 1, constant_values=False)
    touching = padded[1:-1, :-2] | padded[1:-1, 2:] | padded[:-2, 1:-1] | padded[2:, 1:-1]
    soften = ~is_bg & touching
    out[..., 3] = np.where(soften, np.minimum(out[..., 3], 150), out[..., 3])
    return out
