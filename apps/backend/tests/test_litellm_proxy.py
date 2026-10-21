"""LiteLLM proxy credentials come exclusively from validated JSON settings."""

import asyncio
import json
import runpy
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi import FastAPI, Request

from app import authentication
from app.clients.auth_service import AuthenticatedUser
from app.clients.litellm.identity import LiteLLMIdentityClient
from app.clients.litellm.transport import LiteLLMTransport
from app.core import config
from app.proxies import litellm


@pytest.fixture
def configured_settings(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[tuple[dict[str, Any], Path]]:
    raw = json.loads((config.BASE_DIR / "config_template.json").read_text())
    raw["LITELLM"].update(
        UPSTREAM_URL="http://localhost:4000",
        UPSTREAM_ROOT_PATH="/",
        API_KEY="configured-api-key",
        IDENTITY_SYNC_ENABLED=False,
    )
    path = tmp_path / "config.json"
    path.write_text(json.dumps(raw))
    monkeypatch.setattr(config, "BASE_DIR", tmp_path)
    config.get_settings.cache_clear()
    yield raw, path
    config.get_settings.cache_clear()


@pytest.mark.parametrize("enabled", [None, False, True])
def test_browser_proxy_is_explicitly_opt_in(
    configured_settings: tuple[dict[str, Any], Path], enabled: bool | None
) -> None:
    raw, path = configured_settings
    if enabled is None:
        raw["LITELLM"].pop("UI_ENABLED")
    else:
        raw["LITELLM"]["UI_ENABLED"] = enabled
    path.write_text(json.dumps(raw))
    assert config.get_settings().litellm.ui_enabled is (enabled is True)
    namespace = runpy.run_path(str(Path(__file__).resolve().parents[1] / "app" / "main.py"))
    names = {getattr(route, "name", None) for route in namespace["app"].routes}
    assert ("litellm-ui" in names) is (enabled is True)
    assert ("litellm-ui-root" in names) is (enabled is True)
    assert "litellm-proxy" in names


@pytest.mark.parametrize("value", [None, "true", 1, 0])
def test_browser_proxy_rejects_non_boolean_opt_in(
    configured_settings: tuple[dict[str, Any], Path], value: object
) -> None:
    raw, path = configured_settings
    raw["LITELLM"]["UI_ENABLED"] = value
    path.write_text(json.dumps(raw))
    with pytest.raises(config.ConfigurationError, match="config.LITELLM.UI_ENABLED"):
        config.get_settings()


UI_LIMITS = [
    ("UI_BODY_IDLE_TIMEOUT_SECONDS", "ui_body_idle_timeout_seconds", 30),
    ("UI_WRITE_TIMEOUT_SECONDS", "ui_write_timeout_seconds", 30),
    ("UI_REQUEST_TIMEOUT_SECONDS", "ui_request_timeout_seconds", 360),
    ("UI_MAX_REQUEST_BODY_BYTES", "ui_max_request_body_bytes", 33554432),
]


@pytest.mark.parametrize("key, attribute, default", UI_LIMITS)
@pytest.mark.parametrize("value", [None, 7])
def test_browser_resource_limits_default_without_config_changes(
    configured_settings: tuple[dict[str, Any], Path], key: str, attribute: str, default: int, value: int | None
) -> None:
    raw, path = configured_settings
    if value is None:
        raw["LITELLM"].pop(key)
    else:
        raw["LITELLM"][key] = value
    path.write_text(json.dumps(raw))
    assert getattr(config.get_settings().litellm, attribute) == (default if value is None else value)


@pytest.mark.parametrize("key, attribute, default", UI_LIMITS)
@pytest.mark.parametrize("value", [None, False, 0, -1, "30"])
def test_invalid_browser_resource_limits_fail_at_startup(
    configured_settings: tuple[dict[str, Any], Path], key: str, attribute: str, default: int, value: object
) -> None:
    raw, path = configured_settings
    raw["LITELLM"][key] = value
    path.write_text(json.dumps(raw))
    with pytest.raises(config.ConfigurationError, match=f"config.LITELLM.{key}"):
        config.get_settings()


@pytest.mark.parametrize("key", ["READ_TIMEOUT_SECONDS", "MANAGEMENT_MAX_CONNECTIONS", "DECISION_MAX_CONCURRENCY"])
@pytest.mark.parametrize("value", [None, False, 0, -1, "120"])
def test_invalid_stream_pool_settings_fail_at_startup(
    configured_settings: tuple[dict[str, Any], Path], key: str, value: object
) -> None:
    raw, path = configured_settings
    raw["LITELLM"][key] = value
    path.write_text(json.dumps(raw))
    with pytest.raises(config.ConfigurationError, match=f"config.LITELLM.{key}"):
        config.get_settings()


@pytest.mark.parametrize(
    "key, attribute, default",
    [
        ("READ_TIMEOUT_SECONDS", "read_timeout_seconds", 360),
        ("MANAGEMENT_MAX_CONNECTIONS", "management_max_connections", 20),
        ("DECISION_MAX_CONCURRENCY", "decision_max_concurrency", 10),
    ],
)
@pytest.mark.parametrize("value", [None, 7])
def test_stream_pool_settings_defaults_and_configured_values(
    configured_settings: tuple[dict[str, Any], Path], key: str, attribute: str, default: int, value: int | None
) -> None:
    raw, path = configured_settings
    if key != "DECISION_MAX_CONCURRENCY":
        # Keep the decision cap below any configured management pool size.
        raw["LITELLM"]["DECISION_MAX_CONCURRENCY"] = 1
    if value is None:
        raw["LITELLM"].pop(key)
    else:
        raw["LITELLM"][key] = value
    path.write_text(json.dumps(raw))
    assert getattr(config.get_settings().litellm, attribute) == (default if value is None else value)


@pytest.mark.parametrize("concurrency", [20, 21])
def test_decisions_must_leave_management_capacity_for_identity_sync(
    configured_settings: tuple[dict[str, Any], Path], concurrency: int
) -> None:
    raw, path = configured_settings
    raw["LITELLM"].update(MANAGEMENT_MAX_CONNECTIONS=20, DECISION_MAX_CONCURRENCY=concurrency)
    path.write_text(json.dumps(raw))
    with pytest.raises(config.ConfigurationError, match="DECISION_MAX_CONCURRENCY must be less than"):
        config.get_settings()


def test_settings_load_json_credentials(configured_settings: tuple[dict[str, Any], Path]) -> None:
    settings = config.get_settings().litellm
    assert settings.api_key == "configured-api-key"
    assert settings.api_key not in repr(settings)
    raw, _ = configured_settings
    assert "OPENROUTER" not in raw
    assert not hasattr(config.get_settings(), "openrouter")


@pytest.mark.parametrize("timeout", [None, False, 0, -1, "120"])
def test_invalid_decision_timeout_fails_at_startup(
    configured_settings: tuple[dict[str, Any], Path], timeout: object
) -> None:
    raw, path = configured_settings
    raw["LITELLM"]["DECISION_TIMEOUT_SECONDS"] = timeout
    path.write_text(json.dumps(raw))
    with pytest.raises(config.ConfigurationError, match="config.LITELLM.DECISION_TIMEOUT_SECONDS"):
        config.get_settings()


@pytest.mark.parametrize("timeout", [None, 7])
def test_decision_timeout_default_and_configured_value(
    configured_settings: tuple[dict[str, Any], Path], timeout: int | None
) -> None:
    raw, path = configured_settings
    if timeout is None:
        raw["LITELLM"].pop("DECISION_TIMEOUT_SECONDS")
    else:
        raw["LITELLM"]["DECISION_TIMEOUT_SECONDS"] = timeout
    path.write_text(json.dumps(raw))
    assert config.get_settings().litellm.decision_timeout_seconds == (120 if timeout is None else timeout)


@pytest.mark.parametrize("value", [None, 123, "key with spaces", "key\nvalue"])
def test_invalid_credentials_fail_at_startup(configured_settings: tuple[dict[str, Any], Path], value: object) -> None:
    raw, path = configured_settings
    raw["LITELLM"]["API_KEY"] = value
    path.write_text(json.dumps(raw))
    with pytest.raises(config.ConfigurationError, match="config.LITELLM.API_KEY"):
        config.get_settings()


def test_team_settings_default_when_omitted(configured_settings: tuple[dict[str, Any], Path]) -> None:
    raw, path = configured_settings
    raw["LITELLM"].pop("TEAM_ID")
    raw["LITELLM"].pop("TEAM_ROLE")
    path.write_text(json.dumps(raw))
    settings = config.get_settings().litellm
    assert settings.team_id == ""
    assert settings.team_role == "user"


@pytest.mark.parametrize("team_id", [None, "", "   "])
def test_identity_sync_requires_an_explicit_litellm_team(
    configured_settings: tuple[dict[str, Any], Path], team_id: str | None
) -> None:
    raw, path = configured_settings
    raw["LITELLM"]["IDENTITY_SYNC_ENABLED"] = True
    if team_id is None:
        raw["LITELLM"].pop("TEAM_ID")
    else:
        raw["LITELLM"]["TEAM_ID"] = team_id
    path.write_text(json.dumps(raw))
    with pytest.raises(config.ConfigurationError, match="TEAM_ID is required"):
        config.get_settings()


@pytest.mark.parametrize("role", ["user", "admin"])
def test_configured_team_settings(configured_settings: tuple[dict[str, Any], Path], role: str) -> None:
    raw, path = configured_settings
    raw["LITELLM"].update(TEAM_ID=" existing-team-id ", TEAM_ROLE=f" {role} ")
    path.write_text(json.dumps(raw))
    settings = config.get_settings().litellm
    assert settings.team_id == "existing-team-id"
    assert settings.team_role == role


@pytest.mark.parametrize("value", [None, 123, [], {}, "", "manager", "proxy_admin", "USER"])
def test_invalid_team_role_fails_at_startup(configured_settings: tuple[dict[str, Any], Path], value: object) -> None:
    raw, path = configured_settings
    raw["LITELLM"]["TEAM_ROLE"] = value
    path.write_text(json.dumps(raw))
    with pytest.raises(config.ConfigurationError, match="config.LITELLM.TEAM_ROLE"):
        config.get_settings()


@pytest.mark.parametrize("value", [None, 123, [], {}, "team with spaces", "team\nvalue"])
def test_invalid_team_id_fails_at_startup(configured_settings: tuple[dict[str, Any], Path], value: object) -> None:
    raw, path = configured_settings
    raw["LITELLM"]["TEAM_ID"] = value
    path.write_text(json.dumps(raw))
    with pytest.raises(config.ConfigurationError, match="config.LITELLM.TEAM_ID"):
        config.get_settings()


def test_proxy_uses_config_not_environment(
    configured_settings: tuple[dict[str, Any], Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("LITELLM_API_KEY", "wrong-environment-key")

    async def run() -> None:
        user = AuthenticatedUser(
            user_id=42,
            user_email="dev@example.com",
        )

        async def authenticate(request: Request) -> AuthenticatedUser:
            request.state.authenticated_user = user
            return user

        monkeypatch.setattr(authentication, "authenticate_identity", authenticate)
        seen = []

        def upstream(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return httpx.Response(200, json={"data": []})

        app = FastAPI()
        settings = config.get_settings().litellm
        app.mount("/litellm", authentication.AuthenticatedSessionMiddleware(litellm.LiteLLMProxy()))
        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as upstream_client:
            transport = LiteLLMTransport(settings, client=upstream_client)
            app.state.litellm_transport = transport
            app.state.litellm_identity_client = LiteLLMIdentityClient(settings, transport)
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://backend.test"
            ) as client:
                response = await client.get("/litellm/v1/models", headers={"Authorization": "Bearer session"})
        assert response.status_code == 200
        assert len(seen) == 1
        request = seen[0]
        assert str(request.url) == "http://localhost:4000/v1/models"
        assert request.headers["authorization"] == "Bearer configured-api-key"
        assert request.headers["x-litellm-end-user-id"] == "42"
        assert "x-auth-context" not in request.headers

    asyncio.run(run())
