"""The tagger's output: lenient on purpose. Unknown colours or seasons are dropped and an unknown
pattern, fit or confidence falls back to a default rather than failing the photo; a wrong category,
a non-boolean is_clothing or an out-of-range formality is invalid (the tagger is asked again)."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StrictBool, ValidationError, field_validator

from app.taxonomy import CATEGORIES, COLORS, FITS, PATTERNS, SEASONS

_COLOR_SET = set(COLORS)
_SEASON_SET = set(SEASONS)


def _clean(value: Any, *, lower: bool) -> Any:
    if isinstance(value, str):
        value = value.strip()
        return value.lower() if lower else value
    return value


class TaggerOutput(BaseModel):
    model_config = ConfigDict(extra="ignore")

    is_clothing: StrictBool
    item_count: int = Field(default=1, ge=0)
    category: Literal["top", "bottom", "one_piece", "outer", "shoes", "accessory"]
    subcategory: str | None = Field(default=None, max_length=40)
    colors: list[str]
    pattern: str = "other"
    seasons: list[str]
    fabric: str | None = Field(default=None, max_length=30)
    formality: int = Field(ge=1, le=5)
    fit: str = "regular"
    brand: str | None = Field(default=None, max_length=40)
    confidence: float = 0.5

    @field_validator("subcategory", "fabric", mode="before")
    @classmethod
    def _lower(cls, v: Any) -> Any:
        return _clean(v, lower=True)

    @field_validator("brand", mode="before")
    @classmethod
    def _trim(cls, v: Any) -> Any:
        return _clean(v, lower=False)

    @field_validator("colors", mode="before")
    @classmethod
    def _colors(cls, v: Any) -> Any:
        if not isinstance(v, list):
            return v
        return [c for c in (_clean(x, lower=True) for x in v) if c in _COLOR_SET][:3]

    @field_validator("seasons", mode="before")
    @classmethod
    def _seasons(cls, v: Any) -> Any:
        if not isinstance(v, list):
            return v
        kept = [s for s in (_clean(x, lower=True) for x in v) if s in _SEASON_SET]
        return kept or ["all"]

    @field_validator("pattern", mode="before")
    @classmethod
    def _pattern(cls, v: Any) -> str:
        return v if v in PATTERNS else "other"

    @field_validator("fit", mode="before")
    @classmethod
    def _fit(cls, v: Any) -> str:
        return v if v in FITS else "regular"

    @field_validator("formality", "item_count", mode="before")
    @classmethod
    def _int(cls, v: Any) -> Any:
        if isinstance(v, str) and v.strip():
            try:
                return float(v.strip())
            except ValueError:
                return v
        return v

    @field_validator("confidence", mode="before")
    @classmethod
    def _confidence(cls, v: Any) -> float:
        try:
            n = float(v)
        except (TypeError, ValueError):
            return 0.5
        return n if 0 <= n <= 1 else 0.5


def parse_tagger_output(data: Any) -> TaggerOutput:
    """Raises ValueError naming (up to three of) the problems."""
    try:
        return TaggerOutput.model_validate(data)
    except ValidationError as err:
        raise ValueError(issues(err)) from None


def issues(err: ValidationError) -> str:
    return "; ".join(f"{'.'.join(str(p) for p in e['loc']) or 'body'}: {e['msg']}" for e in err.errors()[:3])


# JSON Schema sent to models that support structured output.
TAGGER_JSON_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "is_clothing": {"type": "boolean"},
        "item_count": {"type": "integer"},
        "category": {"type": "string", "enum": list(CATEGORIES)},
        "subcategory": {"type": "string"},
        "colors": {"type": "array", "items": {"type": "string", "enum": list(COLORS)}, "maxItems": 3},
        "pattern": {"type": "string", "enum": list(PATTERNS)},
        "seasons": {"type": "array", "items": {"type": "string", "enum": list(SEASONS)}},
        "fabric": {"type": "string", "nullable": True},
        "formality": {"type": "integer", "minimum": 1, "maximum": 5},
        "fit": {"type": "string", "enum": list(FITS)},
        "brand": {"type": "string", "nullable": True},
        "confidence": {"type": "number"},
    },
    "required": ["is_clothing", "item_count", "category", "colors", "pattern", "seasons", "formality", "fit", "confidence"],
}
