"""From the tagger's (lenient, model-shaped) output to the contract's ItemTags."""

from __future__ import annotations

import json
import math
import re
from typing import Any

from warewise_contracts import ItemTags

from app.schemas import TaggerOutput


def round_half_up(x: float, digits: int = 2) -> float:
    """JavaScript's Math.round(x * 100) / 100 (Python's round() rounds halves to even)."""
    f = 10**digits
    return math.floor(x * f + 0.5) / f


def _blank(s: str | None) -> str | None:
    return s.strip() if s and s.strip() else None


def to_item_tags(t: TaggerOutput, model: str) -> ItemTags:
    """No missing fields, empty strings become null, numbers clamped, colours de-duplicated."""
    return ItemTags(
        category=t.category,
        subcategory=_blank(t.subcategory),
        colors=list(dict.fromkeys(t.colors))[:3],
        pattern=t.pattern,
        seasons=list(dict.fromkeys(t.seasons)),
        fabric=_blank(t.fabric),
        formality=min(5, max(1, math.floor(t.formality + 0.5))),
        fit=t.fit,
        brand=_blank(t.brand),
        confidence=min(1.0, max(0.0, round_half_up(t.confidence))),
        model=model,
    )


_FENCE = re.compile(r"```(?:json)?\s*([\s\S]*?)```", re.IGNORECASE)


def extract_json(text: str | None) -> Any:
    """The first JSON object in a model reply. Free models sometimes wrap JSON in prose or code
    fences even when asked not to. None when there is none."""
    if not text:
        return None
    fenced = _FENCE.search(text)
    candidate = fenced.group(1) if fenced else text
    start, end = candidate.find("{"), candidate.rfind("}")
    if start == -1 or end <= start:
        return None
    try:
        return json.loads(candidate[start : end + 1])
    except ValueError:
        return None
