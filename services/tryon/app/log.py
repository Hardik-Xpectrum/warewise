"""One JSON object per line (level, msg, time, jobId, userId). Never photo data or secrets."""

from __future__ import annotations

import json
import os
import sys
from datetime import UTC, datetime
from typing import Any

ORDER = ["debug", "info", "warn", "error"]


def log(level: str, msg: str, **fields: Any) -> None:
    minimum = os.environ.get("LOG_LEVEL", "info").lower().replace("warning", "warn")
    if ORDER.index(level) < ORDER.index(minimum if minimum in ORDER else "info"):
        return
    line = json.dumps(
        {"level": level, "msg": msg, "time": datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z"), "service": "tryon", **fields},
        default=str,
    )
    print(line, file=sys.stderr if level in ("warn", "error") else sys.stdout, flush=True)


def error_message(err: BaseException | object) -> str:
    """A readable one-line message; the Gradio client sometimes raises with an empty message."""
    if isinstance(err, BaseException):
        text = str(err)
        return text or type(err).__name__
    if isinstance(err, dict | list):
        return json.dumps(err)
    return str(err)
