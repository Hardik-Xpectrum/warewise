"""Which AI try-on passes dress a whole outfit, and how failures read to people. Models like Leffa
dress one garment per pass, so a top + bottom outfit takes two passes, each on the previous
result. Pure and unit-tested."""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal
from zoneinfo import ZoneInfo

PACIFIC = ZoneInfo("America/Los_Angeles")


@dataclass(frozen=True)
class TryOnPass:
    garment_id: str
    region: Literal["upper_body", "lower_body", "dresses"]
    model: Literal["viton_hd", "dress_code"]
    label: str


def plan_passes(garments: list[dict]) -> list[TryOnPass]:
    """A dress is one pass. Otherwise the visible upper garment (a layer beats the top under it)
    goes first, then the bottom, so the top's hem sits naturally over the trousers' waist.
    `garments` are dicts with `id` and `slot`."""
    dress = next((g for g in garments if g["slot"] == "one_piece"), None)
    if dress:
        return [TryOnPass(dress["id"], "dresses", "dress_code", "dress")]
    passes: list[TryOnPass] = []
    upper = next((g for g in garments if g["slot"] == "outer"), None) or next((g for g in garments if g["slot"] == "top"), None)
    if upper:
        passes.append(TryOnPass(upper["id"], "upper_body", "viton_hd", "layer" if upper["slot"] == "outer" else "top"))
    bottom = next((g for g in garments if g["slot"] == "bottom"), None)
    if bottom:
        passes.append(TryOnPass(bottom["id"], "lower_body", "dress_code", "bottom"))
    return passes


_RETRY = re.compile(r"try again in (\d+):(\d+):(\d+)", re.IGNORECASE)


def retry_hint(message: str) -> str | None:
    """"Try again in 18:52:11" in a Hugging Face quota error -> "in about 19 hours"."""
    m = _RETRY.search(message)
    if not m:
        return None
    h, mi, s = (int(x) for x in m.groups())
    return _about_minutes(h * 60 + mi + (1 if s > 0 else 0))


def _round_half_up(x: float) -> int:
    return math.floor(x + 0.5)  # like JavaScript's Math.round (Python's round() is half-to-even)


def _about_minutes(minutes: int) -> str:
    if minutes < 60:
        return f"in about {max(1, minutes)} minute{'' if minutes == 1 else 's'}"
    hours = _round_half_up(minutes / 60)
    return f"in about {hours} hour{'' if hours == 1 else 's'}"


def until_pacific_midnight(now: datetime) -> str:
    """Our own daily limits reset at midnight Pacific time, like Hugging Face's free GPU quota."""
    local = now.astimezone(PACIFIC)
    return _about_minutes(24 * 60 - (local.hour * 60 + local.minute))


_QUOTA = re.compile(r"quota|exceeded|rate limit|429|free quota used", re.IGNORECASE)


def is_quota_error(message: str) -> bool:
    return bool(_QUOTA.search(message))


def failure_message(errors: list[str], now: datetime | None = None) -> tuple[str, bool]:
    """The one line a person sees when nothing could be dressed, and whether it is a quota failure.
    A quota failure carries the wait time when Hugging Face told us ("Try again in 5:12:00")."""
    now = now or datetime.now(UTC)
    if any("IndexError" in e for e in errors):
        return "The AI couldn't find a body in this photo. Use a clear, front-facing photo showing your upper body.", False
    if errors and all(is_quota_error(e) for e in errors):
        hint = next((h for h in map(retry_hint, errors) if h), None)
        if hint is None and any("free quota used" in e for e in errors):
            hint = until_pacific_midnight(now)
        return f"The free GPU time is used up; it resets {hint or 'later today'}. The instant preview still works.", True
    return "The AI try-on service is unavailable right now. The instant preview still works.", False
