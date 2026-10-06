"""Walks a job's model chain. Pure logic (the calls are injected), so it is unit-tested."""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Literal

from app.ai.config import JobConfig, ModelConfig


@dataclass
class ChatRequest:
    job: str
    messages: list[dict[str, Any]]
    tools: list[dict[str, Any]] | None = None
    # Ask for a JSON object: {"name": ..., "schema": ...}; the schema is used where the model supports it.
    json: dict[str, Any] | None = None
    needs_images: bool = False
    user_id: str | None = None
    request_id: str | None = None


@dataclass
class ChatResult:
    content: str | None
    model_key: str
    provider_model: str


@dataclass
class CallOutcome:
    ok: bool
    content: str | None = None
    kind: Literal["rate_limited", "failed"] | None = None
    error: str | None = None
    tokens_in: int | None = None
    tokens_out: int | None = None


@dataclass
class Attempt:
    model_key: str
    provider_model: str
    status: Literal["ok", "error", "skipped"]
    error: str | None = None
    latency_ms: int | None = None
    tokens_in: int | None = None
    tokens_out: int | None = None


@dataclass
class ChainDeps:
    has_credentials: Callable[[ModelConfig], bool]
    take_quota: Callable[[str, ModelConfig], bool]
    call: Callable[[ModelConfig, JobConfig, ChatRequest], CallOutcome]
    now: Callable[[], float] = field(default=time.monotonic)


class AiUnavailableError(Exception):
    """No model in the chain could take the call (no keys, no free quota, or all failing)."""

    def __init__(self, reason: Literal["quota", "failed"], attempts: list[Attempt]):
        super().__init__(f"AI unavailable ({reason}): " + ", ".join(f"{a.model_key}={a.error or a.status}" for a in attempts))
        self.reason = reason
        self.attempts = attempts


def run_chain(job: JobConfig, models: dict[str, ModelConfig], req: ChatRequest, deps: ChainDeps) -> tuple[ChatResult, list[Attempt]]:
    """Skips models without keys, without the needed capabilities or out of free quota; moves on
    when a provider rate-limits or fails."""
    attempts: list[Attempt] = []
    saw_quota_only = True
    for key in job.chain:
        model = models[key]

        def skip(error: str, key: str = key, model: ModelConfig = model) -> None:
            attempts.append(Attempt(key, model.model, "skipped", error))

        if not deps.has_credentials(model):
            skip("no api key")
            continue
        if req.needs_images and not model.supports.images:
            skip("no image support")
            continue
        if req.tools and not model.supports.tools:
            skip("no tool support")
            continue
        if not deps.take_quota(key, model):
            skip("free quota used")
            continue

        started = deps.now()
        outcome = deps.call(model, job, req)
        latency = round((deps.now() - started) * 1000)
        if outcome.ok:
            attempts.append(Attempt(key, model.model, "ok", None, latency, outcome.tokens_in, outcome.tokens_out))
            return ChatResult(outcome.content, key, model.model), attempts
        if outcome.kind != "rate_limited":
            saw_quota_only = False
        attempts.append(Attempt(key, model.model, "error", outcome.error, latency))

    any_tried = any(a.status == "error" for a in attempts)
    raise AiUnavailableError("failed" if any_tried and not saw_quota_only else "quota", attempts)
