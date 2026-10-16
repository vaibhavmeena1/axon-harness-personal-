"""Shared Python/JavaScript contract for partial, launch-only preferences."""

import asyncio
import json
from pathlib import Path

import pytest

from app.core import config as config_module
from app.core.cli_config import parse_cli_compaction, parse_cli_litellm_client, parse_cli_model_recommender
from app.core.config import ConfigurationError, get_settings
from app.routers.cli_config import client_config

FIXTURES = json.loads(
    (Path(__file__).resolve().parents[2] / "cli/tests/fixtures/client-launch-preferences.json").read_text()
)["sections"]
PARSERS = {
    "COMPACTION": parse_cli_compaction,
    "MODEL_RECOMMENDER": parse_cli_model_recommender,
    "LITELLM_CLIENT": parse_cli_litellm_client,
}


@pytest.mark.parametrize("name", PARSERS)
def test_shared_valid_contract(name: str) -> None:
    parser = PARSERS[name]
    assert parser({}) is None
    assert parser({"CLI_CLIENT_CONFIG": None}) is None
    assert parser({"CLI_CLIENT_CONFIG": {}}) is None
    for case in FIXTURES[name]["valid"]:
        config = parser({"CLI_CLIENT_CONFIG": {name: case["input"]}})
        assert (config.model_dump(by_alias=True, exclude_none=True) if config else None) == case["output"]


@pytest.mark.parametrize("name", PARSERS)
def test_shared_invalid_contract(name: str) -> None:
    for invalid in FIXTURES[name]["invalid"]:
        with pytest.raises(ValueError):
            PARSERS[name]({"CLI_CLIENT_CONFIG": {name: invalid}})


@pytest.mark.parametrize("name", PARSERS)
def test_non_finite_numbers_and_non_object_envelopes(name: str) -> None:
    for section in [False, [], "private"]:
        with pytest.raises(ValueError):
            PARSERS[name]({"CLI_CLIENT_CONFIG": section})
    for key in FIXTURES[name]["fields"]:
        if key in {"ENABLED", "MODEL"}:
            continue
        for value in [float("inf"), float("-inf"), float("nan")]:
            with pytest.raises(ValueError):
                PARSERS[name]({"CLI_CLIENT_CONFIG": {name: {key: value}}})


def test_template_is_noop_and_partial_overrides_project_without_defaults(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    template = json.loads((Path(__file__).resolve().parents[1] / "config_template.json").read_text())
    monkeypatch.setattr(config_module, "BASE_DIR", tmp_path)
    try:
        for name in PARSERS:
            assert template["CLI_CLIENT_CONFIG"][name] == dict.fromkeys(FIXTURES[name]["fields"])
        (tmp_path / "config.json").write_text(json.dumps(template))
        get_settings.cache_clear()
        settings = get_settings()
        public = asyncio.run(client_config(settings)).model_dump(by_alias=True, exclude_none=True)
        assert not {"compaction", "modelRecommender", "litellmClient"} & public.keys()
        for name in PARSERS:
            template["CLI_CLIENT_CONFIG"][name] = FIXTURES[name]["valid"][3]["input"]
        (tmp_path / "config.json").write_text(json.dumps(template))
        get_settings.cache_clear()
        public = asyncio.run(client_config(get_settings())).model_dump(by_alias=True, exclude_none=True)
        for name, fixture in FIXTURES.items():
            assert public[fixture["wireName"]] == fixture["valid"][3]["output"]
        assert public["pi"] == {"codemodeEnabled": True, "litellmMcpEnabled": True}
        assert len(json.dumps(public).encode()) < 16 * 1024
    finally:
        get_settings.cache_clear()


@pytest.mark.parametrize("name", PARSERS)
def test_invalid_launch_preferences_fail_startup_without_inputs(
    name: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    raw = json.loads((Path(__file__).resolve().parents[1] / "config_template.json").read_text())
    raw["CLI_CLIENT_CONFIG"][name] = {next(iter(FIXTURES[name]["fields"])): "private-secret"}
    (tmp_path / "config.json").write_text(json.dumps(raw))
    monkeypatch.setattr(config_module, "BASE_DIR", tmp_path)
    get_settings.cache_clear()
    try:
        with pytest.raises(ConfigurationError, match="CLI_CLIENT_CONFIG") as error:
            get_settings()
        assert "private-secret" not in str(error.value)
        assert len(str(error.value)) < 128
    finally:
        get_settings.cache_clear()
