"""One JSON object per line (level, msg, time, jobId, userId, ...).

Never pass photo data or secrets in `fields`: these lines end up in the host's log viewer.
"""

from __future__ import annotations

import json
import os
import sys
import traceback
from datetime import UTC, datetime
from typing import Any, Literal

Level = Literal["debug", "info", "warn", "error"]
_ORDER: dict[str, int] = {"debug": 10, "info": 20, "warn": 30, "error": 40}


def log(level: Level, msg: str, **fields: Any) -> None:
    # "warning" (Python's spelling) and "warn" both mean warn, so one LOG_LEVEL fits every service.
    minimum = _ORDER.get(os.environ.get("LOG_LEVEL", "info").lower().replace("warning", "warn"), _ORDER["info"])
    if _ORDER[level] < minimum:
        return
    now = datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    line = json.dumps({"level": level, "msg": msg, "time": now, "service": "vision", **fields}, default=str)
    stream = sys.stderr if level in ("warn", "error") else sys.stdout
    print(line, file=stream, flush=True)


def error_fields(err: BaseException) -> dict[str, str]:
    return {"error": str(err) or type(err).__name__, "stack": "".join(traceback.format_exception(err))[-2000:]}
