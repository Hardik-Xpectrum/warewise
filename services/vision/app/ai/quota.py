"""Free-tier call limits per model (per minute and per day), counted in memory.

One process per service makes an in-memory count good enough. A restart forgets the count, which
errs toward one extra 429 that the chain already treats as "try the next model".
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable

from app.ai.config import Limits

DAY = 86_400.0
MINUTE = 60.0


class QuotaCounter:
    def __init__(self, now: Callable[[], float] = time.time):
        self._calls: dict[str, list[float]] = {}
        self._now = now
        self._lock = threading.Lock()

    def take(self, key: str, limits: Limits) -> bool:
        if not limits.perMinute and not limits.perDay:
            return True
        with self._lock:
            t = self._now()
            recent = [c for c in self._calls.get(key, []) if t - c < DAY]
            last_minute = sum(1 for c in recent if t - c < MINUTE)
            if (limits.perMinute and last_minute >= limits.perMinute) or (limits.perDay and len(recent) >= limits.perDay):
                self._calls[key] = recent
                return False
            recent.append(t)
            self._calls[key] = recent
            return True
