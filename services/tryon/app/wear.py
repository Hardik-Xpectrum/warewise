"""Which slot a garment really fills. Ported from src/modules/tryon/wear.ts (slotFor only). Pure."""

from __future__ import annotations

import re

SLOTS = ("top", "outer", "bottom", "one_piece", "shoes")
REAL_LAYER = re.compile(r"blazer|jacket|coat|cardigan|shrug|waistcoat|vest|overshirt|hoodie|sweater")


def slot_for(category: str | None, subcategory: str | None) -> str | None:
    """Where a piece goes. Something filed under layers that isn't really one (a shirt) counts as a top."""
    if not category or category not in SLOTS:
        return None
    if category == "outer" and subcategory and not REAL_LAYER.search(subcategory):
        return "top"
    return category
