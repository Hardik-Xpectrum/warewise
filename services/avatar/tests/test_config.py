import pytest
from pydantic import ValidationError

from app.config import AiConfig, chain_for, is_multi_view, load_ai_config

cfg = load_ai_config()


def keys(kind, env=None):
    return [k for k, _ in chain_for(kind, cfg, env or {})]


def test_body360_tries_hunyuan_then_trellis_multi():
    assert keys("body360") == ["hf-hunyuan3d-2mv", "hf-trellis-multi"]


def test_photo_tries_trellis_then_sf3d_paid_only_with_keys():
    assert keys("photo") == ["hf-trellis", "hf-sf3d"]
    assert keys("photo", {"TRIPO_API_KEY": "t"}) == ["hf-trellis", "hf-sf3d", "tripo-v3"]
    assert keys("photo", {"FAL_KEY": "f", "MESHY_API_KEY": "m"}) == ["hf-trellis", "hf-sf3d", "fal-trellis", "meshy-lite"]


def test_face_needs_no_engine():
    assert keys("face") == []


def test_avatar_engines_overrides_ignoring_unknown():
    assert keys("body360", {"AVATAR_ENGINES": "mock-3d"}) == ["mock-3d"]
    assert keys("photo", {"AVATAR_ENGINES": " nope , mock-3d,mock-3d"}) == ["mock-3d"]


def test_multi_view_engines():
    assert is_multi_view(cfg.engines["hf-hunyuan3d-2mv"])
    assert is_multi_view(cfg.engines["hf-trellis-multi"])
    assert not is_multi_view(cfg.engines["hf-trellis"])


def test_config_details():
    hy = cfg.engines["hf-hunyuan3d-2mv"]
    assert hy.space == "tencent/Hunyuan3D-2mv" and hy.textured and hy.limits.per_day == 6 and hy.timeout_ms == 300_000
    assert cfg.poll_budget_ms == 200_000


def test_rejects_chain_with_unknown_engine():
    with pytest.raises(ValidationError):
        AiConfig.model_validate({"chains": {"photo": ["ghost"], "body360": ["mock-3d"]}, "engines": {"mock-3d": {"provider": "mock-3d"}}})
