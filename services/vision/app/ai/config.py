"""The tagger's model chain. Code asks for the "tagger" job; config/ai.config.json (or
AI_CONFIG_FILE) decides which real models serve it and in what order, so changing providers is a
config edit, not a code change."""

from __future__ import annotations

import json
import os
from functools import cache
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

DEFAULT_FILE = Path(__file__).resolve().parents[2] / "config" / "ai.config.json"


class Limits(BaseModel):
    perMinute: int | None = Field(default=None, gt=0)
    perDay: int | None = Field(default=None, gt=0)


class Supports(BaseModel):
    images: bool = False
    tools: bool = False
    json_mode: Literal["json_schema", "json_object", "none"] = Field(default="json_object", alias="json")

    model_config = ConfigDict(populate_by_name=True)


class ModelConfig(BaseModel):
    # openai-compatible: any OpenAI-style chat API; local-vision: CLIP + clothes parser in this
    # process; mock: fixed offline answer.
    provider: Literal["openai-compatible", "mock", "local-vision"] = "openai-compatible"
    baseURL: str | None = None
    apiKeyEnv: str | None = None
    model: str
    limits: Limits = Limits()
    supports: Supports = Supports()
    extraHeaders: dict[str, str] | None = None


class JobConfig(BaseModel):
    chain: list[str] = Field(min_length=1)
    promptVersion: str = "v1"
    timeoutMs: int = Field(default=30000, gt=0)
    retries: int = Field(default=1, ge=0, le=5)
    temperature: float | None = Field(default=None, ge=0, le=2)


class AiConfig(BaseModel):
    jobs: dict[str, JobConfig]
    models: dict[str, ModelConfig]

    @model_validator(mode="after")
    def _known_models(self) -> AiConfig:
        for name, job in self.jobs.items():
            for key in job.chain:
                if key not in self.models:
                    raise ValueError(f'Job "{name}" uses unknown model "{key}"')
        return self


@cache
def load_ai_config() -> AiConfig:
    path = os.environ.get("AI_CONFIG_FILE") or DEFAULT_FILE
    return AiConfig.model_validate(json.loads(Path(path).read_text()))
