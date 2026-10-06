"""What the user is told when no engine could build the avatar, and when events are retried."""

from __future__ import annotations

import math
import re

# Events to the web app are retried after 1, 4, 16 and 60 minutes, then hourly, up to 10 tries.
EVENT_DELAYS_MIN = (1, 4, 16, 60)
MAX_EVENT_ATTEMPTS = 10


def retry_hint(message: str) -> str | None:
    """"Try again in 18:52:11" in a Hugging Face quota error -> "in about 19 hours"."""
    m = re.search(r"try again in (\d+):(\d+):(\d+)", message, re.I)
    if not m:
        return None
    h, mi, s = (int(x) for x in m.groups())
    minutes = h * 60 + mi + (1 if s > 0 else 0)
    if minutes < 60:
        n = max(1, minutes)
        return f"in about {n} minute{'' if n == 1 else 's'}"
    hours = math.floor(minutes / 60 + 0.5)
    return f"in about {hours} hour{'' if hours == 1 else 's'}"


def chain_failure(errors: list[str]) -> tuple[str, bool]:
    """Every engine in the chain refused: (friendly message, whether trying later can help)."""
    if not errors:
        return "No 3D service is set up for this kind of scan.", False
    joined = "; ".join(errors)
    if re.search(r"quota|exceeded", joined, re.I):
        hint = retry_hint(joined)
        resets = f"; it resets {hint}" if hint else " for today"
        return (
            f"The free 3D service's GPU quota is used up{resets}. A Hugging Face token with more quota, or a fal.ai, Tripo or Meshy key, avoids this.",
            True,
        )
    return f"No 3D service could take the scan right now. {joined[:300]}", True


def event_retry_delay_s(attempts: int) -> float | None:
    """Delay before the next try after `attempts` failed tries, or None to give up."""
    if attempts >= MAX_EVENT_ATTEMPTS:
        return None
    minutes = EVENT_DELAYS_MIN[attempts - 1] if 1 <= attempts <= len(EVENT_DELAYS_MIN) else 60
    return minutes * 60.0
