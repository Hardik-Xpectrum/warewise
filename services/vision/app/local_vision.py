"""The keyless, on-device tagger's pure parts: what each garment label means, how a garment's
colours are named from its pixels, and which clothes-parsing labels make up its cut-out. The models
that feed these live in local_models.py. Same lists and rules as the TypeScript localVision.ts."""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np
from scipy import ndimage

from app.taxonomy import COLOR_SWATCH, COLORS, Category


@dataclass(frozen=True)
class GarmentDef:
    label: str
    category: Category
    subcategory: str
    formality: int
    fabric: str | None = None
    seasons: list[str] | None = field(default=None)


# What CLIP chooses between. Labels read naturally in "a photo of {label}" and cover everyday
# Indian and western wardrobes; each maps to the tags the rest of the app uses.
GARMENTS: list[GarmentDef] = [
    GarmentDef("a t-shirt", "top", "t-shirt", 2, "cotton"),
    GarmentDef("a graphic print t-shirt", "top", "graphic t-shirt", 1, "cotton"),
    GarmentDef("a polo shirt", "top", "polo shirt", 2, "cotton"),
    GarmentDef("a shirt with a collar and buttons", "top", "shirt", 3, "cotton"),
    GarmentDef("a long Indian kurta tunic", "top", "kurta", 3, "cotton"),
    GarmentDef("a sweater", "top", "sweater", 2, "wool", ["winter"]),
    GarmentDef("a hoodie", "top", "hoodie", 1, "cotton", ["winter"]),
    GarmentDef("a sweatshirt", "top", "sweatshirt", 1, "cotton", ["winter"]),
    GarmentDef("a tank top", "top", "tank top", 1, "cotton", ["summer"]),
    GarmentDef("a women's blouse with frills", "top", "blouse", 3),
    GarmentDef("a crop top", "top", "crop top", 2),
    GarmentDef("a pair of jeans", "bottom", "jeans", 2, "denim"),
    GarmentDef("a pair of chinos", "bottom", "chinos", 3, "cotton"),
    GarmentDef("formal trousers", "bottom", "trousers", 4),
    GarmentDef("a pair of shorts", "bottom", "shorts", 1, None, ["summer"]),
    GarmentDef("track pants", "bottom", "track pants", 1),
    GarmentDef("a skirt", "bottom", "skirt", 2),
    GarmentDef("a dress", "one_piece", "dress", 3),
    GarmentDef("a saree", "one_piece", "saree", 4, None, ["all"]),
    GarmentDef("a lehenga", "one_piece", "lehenga", 5),
    GarmentDef("a jumpsuit", "one_piece", "jumpsuit", 2),
    GarmentDef("a tailored suit blazer", "outer", "blazer", 4),
    GarmentDef("a jacket", "outer", "jacket", 2),
    GarmentDef("a denim jacket", "outer", "denim jacket", 2, "denim"),
    GarmentDef("a leather jacket", "outer", "leather jacket", 2, "leather"),
    GarmentDef("a winter coat", "outer", "coat", 3, "wool", ["winter"]),
    GarmentDef("a sleeveless Nehru jacket vest", "outer", "nehru jacket", 4),
    GarmentDef("a pair of sneakers", "shoes", "sneakers", 2),
    GarmentDef("a pair of sports running shoes", "shoes", "sports shoes", 1),
    GarmentDef("a pair of formal leather shoes", "shoes", "formal shoes", 4, "leather"),
    GarmentDef("a pair of loafers", "shoes", "loafers", 3, "leather"),
    GarmentDef("a pair of sandals", "shoes", "sandals", 1, None, ["summer"]),
    GarmentDef("a pair of high heels", "shoes", "heels", 4),
    GarmentDef("a pair of boots", "shoes", "boots", 3, None, ["winter", "monsoon"]),
    GarmentDef("a pair of sunglasses", "accessory", "sunglasses", 2),
    GarmentDef("a handbag", "accessory", "handbag", 3),
    GarmentDef("a wrist watch", "accessory", "watch", 3),
    GarmentDef("a belt", "accessory", "belt", 3, "leather"),
    GarmentDef("a cap", "accessory", "cap", 1),
    GarmentDef("a scarf", "accessory", "scarf", 2),
]

# Photos that aren't clothing at all; if one of these wins, the upload is refused.
NOT_CLOTHING: list[str] = ["food on a plate", "a landscape", "an animal", "a screenshot of text", "a room interior with furniture"]

# How each pattern is described to CLIP, with the garment's name filled in ("a shirt with stripes").
PATTERN_PROMPTS: dict[str, str] = {
    "solid": "a plain {} in one solid colour with no pattern",
    "striped": "a {} with stripes",
    "checked": "a {} with a checked plaid pattern",
    "floral": "a {} with a floral print",
    "printed": "a {} with a large graphic print or logo",
    "embroidered": "a {} with embroidery",
    "textured": "a chunky knitted {}",
}


def pick_pattern(scores: list[float]) -> str:
    """The pattern from CLIP scores (aligned with PATTERN_PROMPTS' keys). CLIP likes to see a
    pattern in plain clothes, so a pattern has to clearly beat "solid" to be chosen; embroidery,
    which CLIP over-reads most (any seam or button), needs a stronger lead."""
    keys = list(PATTERN_PROMPTS)
    solid = scores[keys.index("solid")]
    best = keys.index("solid")
    for i, k in enumerate(keys):
        lead = 3 if k == "embroidered" else 1.6
        if k != "solid" and scores[i] > solid * lead and scores[i] > scores[best]:
            best = i
    return keys[best]


def pick_garment(scores: list[float]) -> tuple[GarmentDef | None, float]:
    """The best garment from CLIP scores (aligned with GARMENTS then NOT_CLOTHING), with a
    confidence that merges the label's share with its category siblings."""
    best = 0
    for i in range(1, len(scores)):
        if scores[i] > scores[best]:
            best = i
    if best >= len(GARMENTS):
        return None, float(scores[best])
    cat = GARMENTS[best].category
    share = sum(scores[i] for i, g in enumerate(GARMENTS) if g.category == cat)
    return GARMENTS[best], math.floor(min(1.0, share) * 100 + 0.5) / 100


# --- colours ---------------------------------------------------------------------------------


def to_lab(rgb: np.ndarray) -> np.ndarray:
    """sRGB (..., 3) in 0-255 to CIELAB (D65), for colour distances that match what people see."""
    v = np.asarray(rgb, dtype=np.float64) / 255
    lin = np.where(v <= 0.04045, v / 12.92, ((v + 0.055) / 1.055) ** 2.4)
    r, g, b = lin[..., 0], lin[..., 1], lin[..., 2]
    x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047
    y = r * 0.2126 + g * 0.7152 + b * 0.0722
    z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883

    def f(t: np.ndarray) -> np.ndarray:
        return np.where(t > 0.008856, np.cbrt(t), 7.787 * t + 16 / 116)

    fx, fy, fz = f(x), f(y), f(z)
    return np.stack([116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)], axis=-1)


def _hex(h: str) -> tuple[int, int, int]:
    return int(h[1:3], 16), int(h[3:5], 16), int(h[5:7], 16)


# "Silver" and "gold" are for metallic pieces; plain fabric in those tones reads as grey or mustard.
PALETTE_NAMES: list[str] = [c for c in COLORS if c not in ("multi", "silver", "gold")]
_PALETTE_LAB = to_lab(np.array([_hex(COLOR_SWATCH[n]) for n in PALETTE_NAMES]))


def _nearest_index(rgb: np.ndarray) -> np.ndarray:
    lab = to_lab(rgb)
    d = ((lab[..., None, :] - _PALETTE_LAB) ** 2).sum(-1)
    return d.argmin(-1)  # first of equals wins, like the TypeScript loop


def nearest_color(rgb: tuple[int, int, int]) -> str:
    return PALETTE_NAMES[int(_nearest_index(np.array([rgb]))[0])]


def named_colors(rgba: np.ndarray | bytes, min_share: float = 0.12, stride: int = 3) -> list[str]:
    """Names a garment's colours from its RGBA pixels (only opaque ones count): each pixel votes for
    its nearest palette colour; colours with at least `min_share` of the vote are kept, biggest first."""
    px = np.frombuffer(bytes(rgba), dtype=np.uint8) if isinstance(rgba, (bytes, bytearray)) else np.asarray(rgba, dtype=np.uint8)
    px = px.reshape(-1, 4)[::stride]
    px = px[px[:, 3] >= 200]
    if not len(px):
        return []
    # Quantise to 32 levels per channel; each bucket is named after the first pixel that fell in it.
    q = px[:, :3].astype(np.int32) >> 3
    keys = (q[:, 0] << 10) | (q[:, 1] << 5) | q[:, 2]
    uniq, first, inverse = np.unique(keys, return_index=True, return_inverse=True)
    names_per_key = _nearest_index(px[first, :3])
    name_idx = names_per_key[inverse.reshape(-1)]
    total = len(name_idx)
    counts = np.bincount(name_idx, minlength=len(PALETTE_NAMES))
    present = np.nonzero(counts)[0]
    first_seen = {int(n): int(np.argmax(name_idx == n)) for n in present}
    ranked = sorted(present.tolist(), key=lambda n: (-counts[n], first_seen[n]))
    kept = [PALETTE_NAMES[n] for n in ranked if counts[n] / total >= min_share]
    return (kept or [PALETTE_NAMES[ranked[0]]])[:3]


# --- cut-out ---------------------------------------------------------------------------------

# Clothes-parsing labels (segformer_b2_clothes) that belong to each category's garment.
PERSON = ["Hair", "Face", "Left-arm", "Right-arm", "Left-leg", "Right-leg"]
CLOTHING = ["Hat", "Upper-clothes", "Skirt", "Pants", "Dress", "Belt", "Left-shoe", "Right-shoe", "Bag", "Scarf", "Sunglasses"]
FOR_CATEGORY: dict[str, list[str]] = {
    "top": ["Upper-clothes", "Dress"],
    "outer": ["Upper-clothes", "Dress"],
    "bottom": ["Pants", "Skirt"],
    "one_piece": ["Dress", "Upper-clothes", "Skirt", "Pants"],
    "shoes": ["Left-shoe", "Right-shoe"],
    "accessory": ["Hat", "Bag", "Sunglasses", "Belt", "Scarf"],
}


def cutout_labels(area_by_label: dict[str, float], category: Category) -> list[str]:
    """Which parsing labels make the cut-out. When someone is wearing the garment, only the parts
    for its category (a kurta's upper-clothes, not the trousers under it). On a product photo
    there's no body to separate from and the parser's labels are shakier, so all clothing counts."""
    person = sum(area_by_label.get(label, 0.0) for label in PERSON)
    return FOR_CATEGORY[category] if person > 0.01 else CLOTHING


def erode(mask: np.ndarray, r: int) -> np.ndarray:
    """Shrinks a 0/255 (H, W) mask by `r` pixels (square min filter, outside counts as empty)."""
    return ndimage.minimum_filter(mask, size=2 * r + 1, mode="constant", cval=0)


def mask_passes_gate(alpha: np.ndarray, min_cover: float = 0.02, min_fill: float = 0.35) -> bool:
    """The cut-out quality gate for a parsed (H, W) mask. A real garment covers a fair part of the
    photo (at least `min_cover`) and fills a good part of its own bounding box; a parse that came
    out as scattered scraps (close-ups, busy scenes) doesn't, and is better skipped than shown broken."""
    on = alpha > 0
    n = int(on.sum())
    if n / on.size < min_cover or n == 0:
        return False
    ys, xs = np.nonzero(on)
    box = (xs.max() - xs.min() + 1) * (ys.max() - ys.min() + 1)
    return n / box >= min_fill
