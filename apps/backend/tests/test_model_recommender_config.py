"""The backend owns and validates the LiteLLM classifier alias independently of CLI preferences."""

import asyncio
import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from app.core import config
from app.routers.cli_config import client_config
from app.services.model_recommendation.jev import build_jev_request


@pytest.fixture
def configured_settings(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[tuple[dict[str, Any], Path]]:
    raw = json.loads((config.BASE_DIR / "config_template.json").read_text())
    path = tmp_path / "config.json"
    path.write_text(json.dumps(raw))
    monkeypatch.setattr(config, "BASE_DIR", tmp_path)
    config.get_settings.cache_clear()
    try:
        yield raw, path
    finally:
        config.get_settings.cache_clear()


def test_template_configures_jev_114(configured_settings: tuple[dict[str, Any], Path]) -> None:
    raw, _ = configured_settings
    assert raw["MODEL_RECOMMENDER"] == {"CLASSIFIER_MODEL": "typesafe/jev-1.14"}
    assert config.get_settings().model_recommender.classifier_model == "typesafe/jev-1.14"


@pytest.mark.parametrize("include_section", [False, True])
def test_missing_classifier_defaults_to_jev_114(
    configured_settings: tuple[dict[str, Any], Path], include_section: bool
) -> None:
    raw, path = configured_settings
    raw.pop("MODEL_RECOMMENDER")
    if include_section:
        raw["MODEL_RECOMMENDER"] = {}
    path.write_text(json.dumps(raw))
    assert config.get_settings().model_recommender.classifier_model == "typesafe/jev-1.14"


@pytest.mark.parametrize("model", ["typesafe/jev-1.14", "typesafe/jev-1.14.0", "custom/classifier-alias"])
def test_configured_alias_is_used_in_systemone_payload(
    configured_settings: tuple[dict[str, Any], Path], model: str
) -> None:
    raw, path = configured_settings
    raw["MODEL_RECOMMENDER"]["CLASSIFIER_MODEL"] = f"  {model}  "
    path.write_text(json.dumps(raw))
    settings = config.get_settings().model_recommender
    assert settings.classifier_model == model
    payload = build_jev_request("private task", model=settings.classifier_model)
    assert payload["model"] == model
    assert payload["state"] == {"task": "private task"}
    assert set(payload["questions"]) == {"complexity", "needs_deep_reasoning", "prioritizes_speed"}
    assert set(payload) == {"model", "state", "questions"}


@pytest.mark.parametrize("section", [None, False, True, 1, [], "private-invalid-value"])
def test_invalid_section_fails_startup(configured_settings: tuple[dict[str, Any], Path], section: object) -> None:
    raw, path = configured_settings
    raw["MODEL_RECOMMENDER"] = section
    path.write_text(json.dumps(raw))
    with pytest.raises(config.ConfigurationError, match=r"config\.MODEL_RECOMMENDER must be an object") as error:
        config.get_settings()
    assert "private-invalid-value" not in str(error.value)


@pytest.mark.parametrize("model", [None, False, True, 0, 1, 1.5, [], {}, "", " \t\r\n"])
def test_invalid_classifier_fails_startup(configured_settings: tuple[dict[str, Any], Path], model: object) -> None:
    raw, path = configured_settings
    raw["MODEL_RECOMMENDER"]["CLASSIFIER_MODEL"] = model
    path.write_text(json.dumps(raw))
    with pytest.raises(
        config.ConfigurationError, match=r"config\.MODEL_RECOMMENDER\.CLASSIFIER_MODEL must be a non-empty string"
    ):
        config.get_settings()


def test_environment_cannot_override_backend_classifier(
    configured_settings: tuple[dict[str, Any], Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    raw, path = configured_settings
    raw["MODEL_RECOMMENDER"]["CLASSIFIER_MODEL"] = "custom/configured-classifier"
    path.write_text(json.dumps(raw))
    monkeypatch.setenv("MODEL_RECOMMENDER_CLASSIFIER_MODEL", "untrusted/env-classifier")
    monkeypatch.setenv("JEV_MODEL", "untrusted/env-classifier")
    assert config.get_settings().model_recommender.classifier_model == "custom/configured-classifier"


def test_classifier_is_not_a_cli_preference(configured_settings: tuple[dict[str, Any], Path]) -> None:
    raw, path = configured_settings
    raw["MODEL_RECOMMENDER"]["CLASSIFIER_MODEL"] = "custom/backend-only-classifier"
    raw["CLI_CLIENT_CONFIG"]["MODEL_RECOMMENDER"] = {"ENABLED": True}
    path.write_text(json.dumps(raw))
    settings = config.get_settings()
    public = asyncio.run(client_config(settings)).model_dump(by_alias=True, exclude_none=True)
    assert public["modelRecommender"] == {"enabled": True}
    assert "custom/backend-only-classifier" not in json.dumps(public)
    assert "CLASSIFIER_MODEL" not in json.dumps(public)
