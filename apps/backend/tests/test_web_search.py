"""The backend publishes complete, non-secret standalone search preferences."""

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from app.core.web_search import CliWebSearchConfig, WebSearchSettings, parse_web_search
from app.routers import ROUTERS


def test_defaults_and_template_are_synchronized() -> None:
    defaults = parse_web_search({})
    template = json.loads((Path(__file__).resolve().parents[1] / "config_template.json").read_text())
    assert defaults.model == "gemini-3.8-flash"
    assert defaults.thinking_level is None
    assert defaults.search_context_size is None
    assert template["WEB_SEARCH"]["THINKING_LEVEL"] is None
    assert template["WEB_SEARCH"]["SEARCH_CONTEXT_SIZE"] is None
    assert "SEARCH_TOOL" not in template["WEB_SEARCH"]
    assert "THINKING_BUDGET_TOKENS" not in template["WEB_SEARCH"]
    assert parse_web_search(template) == defaults


@pytest.mark.parametrize("level", [None, "low", "medium", "high"])
def test_public_config_publishes_generation_and_grounding_preferences(level: str | None) -> None:
    preferences = parse_web_search(
        {
            "WEB_SEARCH": {
                "ENABLED": True,
                "ALLOWED_MODELS": ["other", "other", "gemini-3.8-flash"],
                "THINKING_LEVEL": level,
                "SEARCH_CONTEXT_SIZE": level,
                "TEMPERATURE": 0.5,
                "USE_URL_CONTEXT": True,
                "REQUIRE_GROUNDING": False,
            }
        }
    )
    public = preferences.cli_config().model_dump(by_alias=True, mode="json", exclude_none=True)
    assert public["model"] == preferences.model
    assert public["allowedModels"] == ["gemini-3.8-flash", "other"]
    assert public["timeoutMs"] == preferences.timeout_seconds * 1000
    assert public["temperature"] == 0.5
    assert public["useUrlContext"] is True
    assert public["requireGrounding"] is False
    if level is None:
        assert "thinkingLevel" not in public
        assert "searchContextSize" not in public
    else:
        assert public["thinkingLevel"] == level
        assert public["searchContextSize"] == level
    for private in ("endpoint", "url", "apiKey", "headers", "user", "team", "searchTool"):
        assert private not in public


@pytest.mark.parametrize("name", ["THINKING_LEVEL", "SEARCH_CONTEXT_SIZE"])
@pytest.mark.parametrize("value", ["minimal", "auto", "HIGH", "", "1024", 1024, True, [], {}])
def test_invalid_levels_are_rejected(name: str, value: object) -> None:
    with pytest.raises(ValidationError):
        parse_web_search({"WEB_SEARCH": {name: value}})


@pytest.mark.parametrize("name", ["SEARCH_TOOL", "THINKING_BUDGET_TOKENS", "API_KEY", "URL", "HEADERS"])
def test_obsolete_or_private_search_settings_are_rejected(name: str) -> None:
    with pytest.raises(ValidationError):
        parse_web_search({"WEB_SEARCH": {name: "secret"}})
    assert "search_tool" not in WebSearchSettings.model_fields
    assert "endpoint" not in CliWebSearchConfig.model_fields


@pytest.mark.parametrize("value", ["", "model with spaces", "x" * 257])
def test_invalid_model_preferences_are_rejected(value: str) -> None:
    with pytest.raises(ValueError):
        parse_web_search({"WEB_SEARCH": {"ALLOWED_MODELS": [value]}})


def test_no_dedicated_search_endpoint_is_registered() -> None:
    assert all(route.path != "/api/v1/web-search" for router in ROUTERS for route in router.routes)
