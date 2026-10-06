"""The item vocabulary the tagger answers in.

Ported from the web app's wardrobe/taxonomy.ts; the two must agree, since the web app stores and
filters on these words.
"""

from __future__ import annotations

from typing import Literal

Category = Literal["top", "bottom", "one_piece", "outer", "shoes", "accessory"]
CATEGORIES: tuple[str, ...] = ("top", "bottom", "one_piece", "outer", "shoes", "accessory")

COLORS: tuple[str, ...] = (
    "black", "white", "grey", "navy", "blue", "light-blue", "beige", "cream", "brown", "tan",
    "olive", "green", "red", "maroon", "pink", "purple", "yellow", "mustard", "orange", "gold", "silver", "multi",
)

PATTERNS: tuple[str, ...] = ("solid", "striped", "checked", "floral", "printed", "embroidered", "textured", "other")

# India-first seasons: most wardrobes split into summer, monsoon and winter wear.
SEASONS: tuple[str, ...] = ("summer", "monsoon", "winter", "all")

FITS: tuple[str, ...] = ("slim", "regular", "relaxed", "oversized", "other")

# Reference colours for naming a garment's pixels ("multi" is never a pixel colour).
COLOR_SWATCH: dict[str, str] = {
    "black": "#1c1c1c", "white": "#ffffff", "grey": "#9a9a9a", "navy": "#1f2a4d", "blue": "#2f5fb3", "light-blue": "#a7c7e7",
    "beige": "#d9c7a7", "cream": "#f3ead3", "brown": "#6b4226", "tan": "#c49a6c", "olive": "#6b6b2e", "green": "#2e7d4f",
    "red": "#c4122f", "maroon": "#6d1a2a", "pink": "#eaa0b4", "purple": "#6c4a9e", "yellow": "#f2d02b", "mustard": "#c9a227",
    "orange": "#e8772e", "gold": "#c8a44d", "silver": "#c0c0c0",
}
