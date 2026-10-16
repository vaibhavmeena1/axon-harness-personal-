"""Terminal permissions are validated and projected without private settings."""

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.core.config import ConfigurationError, _terminal_permissions
from app.core.terminal_permissions import TerminalPermissionsSettings, parse_terminal_permissions
from app.core.web_search import WebSearchSettings
from app.routers.cli_config import client_config


def test_defaults_match_the_configuration_template() -> None:
    template = json.loads((Path(__file__).resolve().parents[1] / "config_template.json").read_text())
    settings = parse_terminal_permissions(template)
    assert settings == TerminalPermissionsSettings()
    assert settings.yolo_mode is False
    assert settings.allow_yolo_mode is True
    assert settings.approval_timeout_seconds == 60
    assert parse_terminal_permissions({}) is None


def test_terminal_preferences_are_projected_into_the_cli_response() -> None:
    policy = TerminalPermissionsSettings.model_validate(
        {
            "YOLO_MODE": True,
            "AUTO_APPROVE_COMMANDS": ["pwd", "git status"],
            "REQUIRE_APPROVAL_COMMANDS": ["git push"],
            "BLOCKED_COMMANDS": ["rm"],
            "APPROVAL_TIMEOUT_SECONDS": 10,
        }
    )
    response = asyncio.run(
        client_config(
            SimpleNamespace(
                cli_telemetry=None,
                cli_pi=None,
                cli_compaction=None,
                cli_model_recommender=None,
                cli_litellm_client=None,
                web_search=WebSearchSettings(),
                terminal_permissions=policy,
            )
        )
    )
    public = response.model_dump(by_alias=True, mode="json", exclude_none=True)
    assert public["terminalPermissions"] == {
        "yoloMode": True,
        "allowYoloMode": True,
        "autoApproveCommands": ["pwd", "git status"],
        "requireApprovalCommands": ["git push"],
        "blockedCommands": ["rm"],
        "approvalTimeoutMs": 10000,
    }
    assert "apiKey" not in public["terminalPermissions"]
    assert "auth_data" not in public


def test_yolo_prohibition_overrides_the_backend_yolo_default() -> None:
    settings = parse_terminal_permissions({"TERMINAL_PERMISSIONS": {"YOLO_MODE": True, "ALLOW_YOLO_MODE": False}})
    assert settings is not None
    assert settings.cli_config().yolo_mode is False
    assert settings.cli_config().allow_yolo_mode is False


@pytest.mark.parametrize(
    "patch",
    [
        {"YOLO_MODE": "true"},
        {"ALLOW_YOLO_MODE": 1},
        {"AUTO_APPROVE_COMMANDS": [""]},
        {"AUTO_APPROVE_COMMANDS": [" "]},
        {"REQUIRE_APPROVAL_COMMANDS": ["rm\n"]},
        {"BLOCKED_COMMANDS": ["rm\u001b"]},
        {"BLOCKED_COMMANDS": ["rm\u0085"]},
        {"BLOCKED_COMMANDS": ["rm"] * 33},
        {"BLOCKED_COMMANDS": ["x" * 97]},
        {"APPROVAL_TIMEOUT_SECONDS": 0},
        {"APPROVAL_TIMEOUT_SECONDS": 301},
        {"APPROVAL_TIMEOUT_SECONDS": 1.5},
        {"API_KEY": "private-credential"},
    ],
)
def test_invalid_terminal_settings_fail_validation(patch: dict) -> None:
    with pytest.raises(ValueError):
        parse_terminal_permissions({"TERMINAL_PERMISSIONS": patch})
    with pytest.raises(ConfigurationError, match="TERMINAL_PERMISSIONS") as error:
        _terminal_permissions({"TERMINAL_PERMISSIONS": patch})
    assert "private-credential" not in str(error.value)


@pytest.mark.parametrize("section", [True, [], "invalid"])
def test_terminal_permissions_must_be_an_object(section: object) -> None:
    with pytest.raises(ValueError):
        parse_terminal_permissions({"TERMINAL_PERMISSIONS": section})
