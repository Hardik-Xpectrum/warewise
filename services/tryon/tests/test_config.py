import tomllib
from pathlib import Path

import pytest
from pydantic import ValidationError

from app import __version__
from app.config import ROOT, AiConfig, engine_mode


def load(name: str) -> AiConfig:
    return AiConfig.model_validate_json(Path(ROOT, "config", name).read_text())


def test_shipped_configs_parse_and_name_their_engine():
    assert engine_mode(load("ai.config.json")) == "ai"
    assert engine_mode(load("ai.config.offline.json")) == "composite"
    assert load("ai.config.json").models["idm-vton-space"].limits.per_day == 15


def test_unknown_chain_entries_are_refused():
    with pytest.raises(ValidationError):
        AiConfig.model_validate({"jobs": {"tryon": {"chain": ["nope"]}}, "models": {}})


def test_version_matches_pyproject():
    assert tomllib.loads(Path(ROOT, "pyproject.toml").read_text())["project"]["version"] == __version__
