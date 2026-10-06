"""Environment and engine configuration.

The environment is checked once at start, so a misconfigured deploy fails loudly instead of per
request. Which 3D engines build which kind of scan lives in config/ai.config.json: moving to a new
free Space (or a paid API) is an edit there, not in code.
"""

from __future__ import annotations

import json
import os
from collections.abc import Mapping
from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field, HttpUrl, ValidationError, model_validator

ScanKind = Literal["photo", "body360", "face"]
Provider = Literal["hf-hunyuan3d-mv", "hf-trellis-multi", "hf-trellis", "hf-sf3d", "fal-3d", "tripo-3d", "meshy-3d", "mock-3d"]

DEFAULT_AI_CONFIG = Path(__file__).resolve().parent.parent / "config" / "ai.config.json"


# ---------------------------------------------------------------------------------------------
# Environment
# ---------------------------------------------------------------------------------------------


class Env(BaseModel):
    port: int = Field(default=7860, gt=0)
    service_secret: str = Field(min_length=32)
    web_url: HttpUrl
    supabase_url: HttpUrl
    supabase_secret_key: str = Field(min_length=20)
    hf_token: str | None = None
    log_level: Literal["debug", "info", "warn", "error"] = "info"
    storage_bucket: str = "wardrobe"
    worker_interval_s: float = Field(default=5.0, gt=0)


def read_env(source: Mapping[str, str] | None = None) -> Env:
    src = os.environ if source is None else source
    raw = {
        "port": src.get("PORT") or 7860,
        "service_secret": src.get("SERVICE_SECRET", ""),
        "web_url": src.get("WEB_URL", ""),
        "supabase_url": src.get("SUPABASE_URL", ""),
        "supabase_secret_key": src.get("SUPABASE_SECRET_KEY", ""),
        "hf_token": src.get("HF_TOKEN") or None,
        # "warning" (Python's spelling) and "warn" both mean warn, so one LOG_LEVEL fits every service.
        "log_level": {"warning": "warn"}.get((src.get("LOG_LEVEL") or "info").lower(), (src.get("LOG_LEVEL") or "info").lower()),
        "storage_bucket": src.get("STORAGE_BUCKET") or "wardrobe",
        "worker_interval_s": float(src.get("WORKER_INTERVAL_MS") or 5000) / 1000,
    }
    try:
        return Env.model_validate(raw)
    except ValidationError as err:
        # Field names only: the values may be secrets.
        issues = "; ".join(f"{'.'.join(str(p) for p in e['loc']).upper()}: {e['msg']}" for e in err.errors())
        raise RuntimeError(f"Bad environment: {issues}") from None


# ---------------------------------------------------------------------------------------------
# Engines
# ---------------------------------------------------------------------------------------------


class EngineLimits(BaseModel):
    per_day: int | None = Field(default=None, gt=0, alias="perDay")


class EngineConfig(BaseModel):
    provider: Provider
    space: str | None = None  # Hugging Face Space id for hf-* providers
    model: str | None = None  # model id for paid APIs
    api_key_env: str | None = Field(default=None, alias="apiKeyEnv")
    # Call without a key when it is missing (Hugging Face allows anonymous use with a smaller quota).
    token_optional: bool = Field(default=False, alias="tokenOptional")
    textured: bool = True
    timeout_ms: int = Field(default=240_000, gt=0, alias="timeoutMs")
    limits: EngineLimits = EngineLimits()


class Chains(BaseModel):
    photo: list[str] = Field(min_length=1)
    body360: list[str] = Field(min_length=1)


class AiConfig(BaseModel):
    chains: Chains
    poll_budget_ms: int = Field(default=200_000, gt=0, alias="pollBudgetMs")
    engines: dict[str, EngineConfig]

    @model_validator(mode="after")
    def _chains_use_known_engines(self) -> AiConfig:
        for kind, chain in self.chains.model_dump().items():
            for key in chain:
                if key not in self.engines:
                    raise ValueError(f'Chain "{kind}" uses unknown engine "{key}"')
        return self


@lru_cache(maxsize=4)
def _load(path: str) -> AiConfig:
    return AiConfig.model_validate(json.loads(Path(path).read_text("utf-8")))


def load_ai_config(path: str | None = None) -> AiConfig:
    return _load(path or os.environ.get("AI_CONFIG_FILE") or str(DEFAULT_AI_CONFIG))


def engine_ready(engine: EngineConfig, env: Mapping[str, str] | None = None) -> bool:
    """Usable now: needs no key (mock, token-optional free Spaces) or its key is set."""
    env = os.environ if env is None else env
    return engine.provider == "mock-3d" or engine.token_optional or bool(engine.api_key_env and env.get(engine.api_key_env))


def chain_for(kind: ScanKind, cfg: AiConfig, env: Mapping[str, str] | None = None) -> list[tuple[str, EngineConfig]]:
    """The engines to try, in order, for a kind of scan. Face scans are made on the phone and need
    no engine. AVATAR_ENGINES (comma list) overrides the chain, e.g. "mock-3d" for development
    without spending GPU quota."""
    env = os.environ if env is None else env
    if kind == "face":
        return []
    override = [s.strip() for s in (env.get("AVATAR_ENGINES") or "").split(",") if s.strip()]
    keys = override or getattr(cfg.chains, kind)
    out: list[tuple[str, EngineConfig]] = []
    for key in dict.fromkeys(keys):  # ordered de-duplication
        engine = cfg.engines.get(key)
        if engine and engine_ready(engine, env):
            out.append((key, engine))
    return out


def is_multi_view(engine: EngineConfig) -> bool:
    """Multi-view engines need the extra views; single-image engines read the front only."""
    return engine.provider in ("hf-hunyuan3d-mv", "hf-trellis-multi")
