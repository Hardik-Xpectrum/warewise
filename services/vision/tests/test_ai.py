import pytest

from app.ai.chain import AiUnavailableError, CallOutcome, ChainDeps, ChatRequest, run_chain
from app.ai.config import AiConfig, Limits, load_ai_config
from app.ai.quota import QuotaCounter

CONFIG = AiConfig.model_validate({
    "jobs": {"stylist": {"chain": ["a", "b", "c"]}},
    "models": {
        "a": {"baseURL": "https://a.example/v1", "apiKeyEnv": "A_KEY", "model": "model-a", "supports": {"tools": True, "images": False}},
        "b": {"baseURL": "https://b.example/v1", "apiKeyEnv": "B_KEY", "model": "model-b", "supports": {"tools": True, "images": True}},
        "c": {"baseURL": "https://c.example/v1", "apiKeyEnv": "C_KEY", "model": "model-c", "supports": {"tools": True, "images": True}},
    },
})
JOB = CONFIG.jobs["stylist"]
OK = CallOutcome(ok=True, content="{}")
REQ = ChatRequest(job="stylist", messages=[{"role": "user", "content": "hi"}])


def deps(**kw):
    return ChainDeps(**{"has_credentials": lambda m: True, "take_quota": lambda k, m: True, "call": lambda m, j, r: OK, **kw})


def test_first_available():
    assert run_chain(JOB, CONFIG.models, REQ, deps())[0].model_key == "a"


def test_skips_and_falls_back():
    call = lambda m, j, r: CallOutcome(ok=False, kind="rate_limited", error="429") if m.model == "model-b" else OK
    result, attempts = run_chain(JOB, CONFIG.models, REQ, deps(has_credentials=lambda m: m.model != "model-a", call=call))
    assert result.model_key == "c"
    assert [(a.model_key, a.status) for a in attempts] == [("a", "skipped"), ("b", "error"), ("c", "ok")]


def test_skips_missing_capability():
    req = ChatRequest(job="stylist", messages=REQ.messages, needs_images=True)
    assert run_chain(JOB, CONFIG.models, req, deps())[0].model_key == "b"


def test_quota_vs_failure():
    with pytest.raises(AiUnavailableError) as e:
        run_chain(JOB, CONFIG.models, REQ, deps(take_quota=lambda k, m: False))
    assert e.value.reason == "quota"
    with pytest.raises(AiUnavailableError) as e:
        run_chain(JOB, CONFIG.models, REQ, deps(call=lambda m, j, r: CallOutcome(ok=False, kind="failed", error="500")))
    assert e.value.reason == "failed"


def test_unknown_model_rejected():
    with pytest.raises(ValueError, match="unknown model"):
        AiConfig.model_validate({"jobs": {"x": {"chain": ["nope"]}}, "models": {}})


def test_shipped_config_skips_keyless_cloud_models(monkeypatch):
    from app.ai import router

    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    cfg = load_ai_config()
    assert cfg.jobs["tagger"].chain[-2:] == ["local-vision", "mock"]
    assert [k for k in cfg.jobs["tagger"].chain if router.has_credentials(cfg.models[k])] == ["local-vision", "mock"]


def test_quota_counter():
    t = [0.0]
    q = QuotaCounter(lambda: t[0])
    assert QuotaCounter().take("m", Limits())
    assert q.take("m", Limits(perMinute=2)) and q.take("m", Limits(perMinute=2))
    assert not q.take("m", Limits(perMinute=2))
    t[0] = 61
    assert q.take("m", Limits(perMinute=2))
    d = QuotaCounter(lambda: t[0])
    t[0] = 0
    for _ in range(3):
        assert d.take("m", Limits(perDay=3))
        t[0] += 120
    assert not d.take("m", Limits(perDay=3))
    t[0] = 86_400 + 1
    assert d.take("m", Limits(perDay=3))
