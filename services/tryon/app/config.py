"""Environment and the AI config file. The config decides which models dress an outfit and in
what order; moving to other Spaces or paid models is an edit there, not in code."""

from __future__ import annotations

import json
import os
from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic.alias_generators import to_camel

from app import __version__

ROOT = Path(__file__).resolve().parent.parent
VERSION = __version__


class _Camel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


class Limits(_Camel):
    per_minute: int | None = Field(default=None, gt=0)
    per_day: int | None = Field(default=None, gt=0)


class ModelConfig(_Camel):
    provider: Literal["hf-idm-vton", "hf-leffa", "composite"]
    space: str | None = None  # Hugging Face Space id, e.g. "yisol/IDM-VTON"
    api_key_env: str | None = None
    # Call without a key when it is missing (Hugging Face allows anonymous use with a smaller quota).
    token_optional: bool = False
    model: str
    limits: Limits = Limits()


class JobConfig(_Camel):
    chain: list[str] = Field(min_length=1)
    prompt_version: str = "v1"
    timeout_ms: int = Field(default=420000, gt=0)


class Jobs(_Camel):
    tryon: JobConfig


class AiConfig(_Camel):
    jobs: Jobs
    models: dict[str, ModelConfig]

    @model_validator(mode="after")
    def _chain_known(self) -> AiConfig:
        for key in self.jobs.tryon.chain:
            if key not in self.models:
                raise ValueError(f'The tryon chain uses unknown model "{key}"')
        return self


def config_file() -> str:
    return os.environ.get("AI_CONFIG_FILE") or "config/ai.config.json"


@lru_cache(maxsize=1)
def load_ai_config() -> AiConfig:
    path = Path(config_file())
    if not path.is_absolute():
        path = ROOT / path
    return AiConfig.model_validate(json.loads(path.read_text()))


def engine_mode(config: AiConfig | None = None) -> Literal["ai", "composite"]:
    """"ai" when the try-on chain has an AI model, else "composite": part of the render cache key."""
    cfg = config or load_ai_config()
    return "ai" if any(cfg.models[k].provider != "composite" for k in cfg.jobs.tryon.chain) else "composite"


def _required(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"{name} is not set")
    return value


class Env:
    @staticmethod
    def port() -> int:
        return int(os.environ.get("PORT", "7860"))

    @staticmethod
    def service_secret() -> str:
        secret = _required("SERVICE_SECRET")
        if len(secret) < 32:
            raise RuntimeError("SERVICE_SECRET must be at least 32 characters")
        return secret

    @staticmethod
    def web_url() -> str:
        return _required("WEB_URL").rstrip("/")

    @staticmethod
    def supabase_url() -> str:
        return _required("SUPABASE_URL")

    @staticmethod
    def supabase_key() -> str:
        return _required("SUPABASE_SECRET_KEY")

    @staticmethod
    def bucket() -> str:
        return os.environ.get("STORAGE_BUCKET") or "wardrobe"

    @staticmethod
    def inline_worker() -> bool:
        """Run the worker inside the HTTP process (default) or separately with `python -m app.worker`."""
        return os.environ.get("WORKER") != "off"

    @staticmethod
    def idle_seconds() -> float:
        return int(os.environ.get("WORKER_IDLE_MS", "5000")) / 1000


env = Env()
