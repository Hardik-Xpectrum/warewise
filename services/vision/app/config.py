"""Environment, read and checked once at startup. Errors name what's missing, never the values.

The AI model chain (config/ai.config.json) is loaded by app.ai.config.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass
from urllib.parse import urlparse

VERSION = "0.2.0"


@dataclass(frozen=True)
class Settings:
    port: int
    service_secret: str
    web_url: str
    supabase_url: str
    supabase_secret_key: str
    model_cache_dir: str | None
    log_level: str


def _is_url(s: str) -> bool:
    u = urlparse(s)
    return u.scheme in ("http", "https") and bool(u.netloc)


def load_settings(env: Mapping[str, str] = os.environ) -> Settings:
    problems: list[str] = []
    port_raw = env.get("PORT") or "7860"
    if not port_raw.isdigit() or int(port_raw) <= 0:
        problems.append("PORT: must be a positive integer")
    secret = env.get("SERVICE_SECRET", "")
    if len(secret) < 32:
        problems.append("SERVICE_SECRET: must be at least 32 characters")
    for name in ("WEB_URL", "SUPABASE_URL"):
        if not _is_url(env.get(name, "")):
            problems.append(f"{name}: must be a URL")
    if not env.get("SUPABASE_SECRET_KEY"):
        problems.append("SUPABASE_SECRET_KEY: required")
    if problems:
        raise RuntimeError("Bad environment: " + "; ".join(problems))
    return Settings(
        port=int(port_raw),
        service_secret=secret,
        web_url=env["WEB_URL"],
        supabase_url=env["SUPABASE_URL"],
        supabase_secret_key=env["SUPABASE_SECRET_KEY"],
        model_cache_dir=env.get("MODEL_CACHE_DIR") or None,
        log_level=env.get("LOG_LEVEL", "info"),
    )
