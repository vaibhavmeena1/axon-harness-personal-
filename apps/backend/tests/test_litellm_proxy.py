"""LiteLLM proxy credentials come exclusively from validated JSON settings."""

import asyncio
import json
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


def test_settings_load_json_credentials(configured_settings: tuple[dict[str, Any], Path]) -> None:
    settings = config.get_settings().litellm
    assert settings.api_key == "configured-api-key"
    assert settings.api_key not in repr(settings)


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
            user_team_id=12,
            user_id=42,
            team_id=7,
            user_email="dev@example.com",
            organization_name="Dev",
            role="member",
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
        assert request.headers["x-litellm-end-user-id"] == "12"
        assert "x-auth-context" not in request.headers

    asyncio.run(run())
