"""One JSON object per line (level, msg, time, service, jobId, userId, ...). Never photo data or secrets."""

from __future__ import annotations

import json
import logging
import os
import sys
from datetime import UTC, datetime
from typing import Any, Literal

Level = Literal["debug", "info", "warn", "error"]
_LEVELS = {"debug": 10, "info": 20, "warn": 30, "error": 40}


def _threshold() -> int:
    return _LEVELS.get(os.environ.get("LOG_LEVEL", "info"), 20)


def log(level: Level, msg: str, **fields: Any) -> None:
    if _LEVELS[level] < _threshold():
        return
    line = {"level": level, "msg": msg, "time": datetime.now(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z"), "service": "avatar"}
    line.update({k: v for k, v in fields.items() if v is not None})
    stream = sys.stderr if level in ("warn", "error") else sys.stdout
    stream.write(json.dumps(line, default=str) + "\n")
    stream.flush()


def error_text(err: BaseException | object) -> str:
    """A one-line message from whatever a library raised (gradio_client raises AppError with the Space's text)."""
    if isinstance(err, BaseException):
        text = str(err) or type(err).__name__
    else:
        message = getattr(err, "message", None)
        text = message if isinstance(message, str) else err if isinstance(err, str) else json.dumps(err, default=str)
    return text.splitlines()[0][:500] if text else "unknown error"


class _JsonHandler(logging.Handler):
    """Routes library logging (httpx, gradio_client, uvicorn) through the same JSON lines."""

    def emit(self, record: logging.LogRecord) -> None:
        level: Level = "error" if record.levelno >= 40 else "warn" if record.levelno >= 30 else "info" if record.levelno >= 20 else "debug"
        try:
            text = record.getMessage().splitlines()[0][:300]
        except Exception:  # noqa: BLE001
            text = str(record.msg)[:300]
        log(level, "library log", logger=record.name, detail=text)


def route_library_logs() -> None:
    root = logging.getLogger()
    root.handlers = [_JsonHandler()]
    root.setLevel(logging.INFO)
    # httpx logs every request URL at INFO; signed URLs carry tokens, so keep it quiet.
    for noisy in ("httpx", "httpx2", "httpcore", "hpack"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        lg = logging.getLogger(name)
        lg.handlers = []
        lg.propagate = True
