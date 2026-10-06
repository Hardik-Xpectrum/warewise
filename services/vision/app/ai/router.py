"""The single entry point for every AI call in the service: picks the provider per the config chain."""

from __future__ import annotations

import base64
import json
import os
import re
from pathlib import Path
from typing import Any

import httpx

from app.ai.chain import AiUnavailableError, CallOutcome, ChainDeps, ChatRequest, ChatResult, run_chain
from app.ai.config import JobConfig, ModelConfig, load_ai_config
from app.ai.quota import QuotaCounter
from app.log import error_fields, log

PROMPTS_DIR = Path(__file__).resolve().parents[2] / "prompts"
_quota = QuotaCounter()
_prompts: dict[str, str] = {}


def load_prompt(job: str, version: str) -> str:
    """Prompts live in prompts/<job>/<version>.md so they can change without touching code."""
    key = f"{job}/{version}"
    if key not in _prompts:
        if not re.fullmatch(r"[a-z0-9_-]+", job, re.I) or not re.fullmatch(r"[a-z0-9_.-]+", version, re.I):
            raise ValueError(f"Bad prompt id {key}")
        _prompts[key] = (PROMPTS_DIR / job / f"{version}.md").read_text()
    return _prompts[key]


def mock_reply(req: ChatRequest) -> str:
    """Offline stand-in: a valid but generic answer, so the app works without any key or model."""
    return json.dumps({
        "is_clothing": True, "item_count": 1, "category": "top", "subcategory": "t-shirt", "colors": ["black"],
        "pattern": "solid", "seasons": ["all"], "fabric": "cotton", "formality": 2, "fit": "regular", "brand": None,
        "confidence": 0.3,
    })


def _response_format(model: ModelConfig, req: ChatRequest) -> dict[str, Any] | None:
    if not req.json or req.tools:
        return None
    if model.supports.json_mode == "json_schema":
        return {"type": "json_schema", "json_schema": {"name": req.json["name"], "schema": req.json["schema"], "strict": False}}
    if model.supports.json_mode == "json_object":
        return {"type": "json_object"}
    return None


def _call_openai_compatible(model: ModelConfig, job: JobConfig, req: ChatRequest) -> CallOutcome:
    body: dict[str, Any] = {"model": model.model, "messages": req.messages}
    if req.tools:
        body["tools"] = req.tools
    if fmt := _response_format(model, req):
        body["response_format"] = fmt
    if job.temperature is not None:
        body["temperature"] = job.temperature
    headers = {"authorization": f"Bearer {os.environ.get(model.apiKeyEnv or '', '')}", **(model.extraHeaders or {})}
    url = (model.baseURL or "").rstrip("/") + "/chat/completions"
    last = "no attempt"
    for _ in range(job.retries + 1):
        try:
            res = httpx.post(url, json=body, headers=headers, timeout=job.timeoutMs / 1000)
        except httpx.HTTPError as err:
            last = f"network {err}"[:300]
            continue
        if res.status_code == 429:
            return CallOutcome(ok=False, kind="rate_limited", error="429 rate limited")
        if res.status_code >= 500:
            last = f"{res.status_code} {res.text[:200]}"
            continue
        if res.status_code >= 400:
            return CallOutcome(ok=False, kind="failed", error=f"{res.status_code} {res.text[:200]}")
        data = res.json()
        choice = (data.get("choices") or [{}])[0].get("message")
        if not choice:
            return CallOutcome(ok=False, kind="failed", error="empty response")
        usage = data.get("usage") or {}
        return CallOutcome(ok=True, content=choice.get("content"), tokens_in=usage.get("prompt_tokens"), tokens_out=usage.get("completion_tokens"))
    return CallOutcome(ok=False, kind="failed", error=last)


def _inline_image(req: ChatRequest) -> bytes | None:
    for m in req.messages:
        if isinstance(m.get("content"), list):
            for part in m["content"]:
                if part.get("type") == "image_url":
                    match = re.match(r"^data:image/[a-z+]+;base64,(.+)$", part["image_url"]["url"], re.S)
                    if match:
                        return base64.b64decode(match.group(1))
    return None


def _local_vision_reply(req: ChatRequest) -> CallOutcome:
    """The keyless on-device tagger: reads the request's image, answers in the tagger's JSON shape."""
    if req.job != "tagger":
        return CallOutcome(ok=False, kind="failed", error="local-vision only serves the tagger")
    image = _inline_image(req)
    if image is None:
        return CallOutcome(ok=False, kind="failed", error="no inline image")
    try:
        from app.local_models import local_tag

        return CallOutcome(ok=True, content=json.dumps(local_tag(image)))
    except Exception as err:
        return CallOutcome(ok=False, kind="failed", error=f"local vision: {err}"[:300])


def call_model(model: ModelConfig, job: JobConfig, req: ChatRequest) -> CallOutcome:
    if model.provider == "mock":
        return CallOutcome(ok=True, content=mock_reply(req))
    if model.provider == "local-vision":
        return _local_vision_reply(req)
    return _call_openai_compatible(model, job, req)


def has_credentials(model: ModelConfig) -> bool:
    # local-vision and mock need no key: they run in this process.
    return model.provider != "openai-compatible" or not model.apiKeyEnv or bool(os.environ.get(model.apiKeyEnv))


def ai_chat(req: ChatRequest) -> ChatResult:
    config = load_ai_config()
    job = config.jobs.get(req.job)
    if job is None:
        raise ValueError(f'Unknown AI job "{req.job}"')
    fields = {"job": req.job, "jobId": req.request_id, "userId": req.user_id}
    try:
        result, attempts = run_chain(job, config.models, req, ChainDeps(
            has_credentials=has_credentials,
            take_quota=lambda key, m: _quota.take(key, m.limits),
            call=call_model,
        ))
    except AiUnavailableError as err:
        log("warn", "ai unavailable", **fields, reason=err.reason, attempts=[a.__dict__ for a in err.attempts])
        raise
    except Exception as err:
        log("error", "ai call crashed", **fields, **error_fields(err))
        raise
    failures = [a.__dict__ for a in attempts if a.status == "error"]
    if failures:
        log("warn", "ai fallback used", **fields, failures=failures)
    ok = next(a for a in attempts if a.status == "ok")
    log("info", "ai call", **fields, model=ok.model_key, latencyMs=ok.latency_ms, tokensIn=ok.tokens_in, tokensOut=ok.tokens_out)
    return result


def job_prompt_version(job: str) -> str:
    cfg = load_ai_config().jobs.get(job)
    return cfg.promptVersion if cfg else "v1"
