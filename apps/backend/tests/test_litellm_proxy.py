"""LiteLLM proxy credentials come exclusively from validated JSON settings."""

import asyncio
import base64
import hashlib
import hmac
import json
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi import FastAPI, Request

from app.clients.auth_service import AuthenticatedUser
from app.core import config
from app.proxies import litellm


@pytest.fixture
def configured_settings(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[tuple[dict[str, Any], Path]]:
    raw = json.loads((config.BASE_DIR / "config_template.json").read_text())
    raw["LITELLM"].update(
        UPSTREAM_URL="http://localhost:4000",
        UPSTREAM_ROOT_PATH="/",
        SERVICE_TOKEN="configured-service-token",
        IDENTITY_SECRET="configured-signing-secret",
    )
    path = tmp_path / "config.json"
    path.write_text(json.dumps(raw))
    monkeypatch.setattr(config, "BASE_DIR", tmp_path)
    config.get_settings.cache_clear()
    yield raw, path
    config.get_settings.cache_clear()


def test_settings_load_json_credentials(configured_settings: tuple[dict[str, Any], Path]) -> None:
    settings = config.get_settings().litellm
    assert settings.service_token == "configured-service-token"
    assert settings.identity_secret == "configured-signing-secret"
    assert settings.service_token not in repr(settings)
    assert settings.identity_secret not in repr(settings)


@pytest.mark.parametrize("key", ["SERVICE_TOKEN", "IDENTITY_SECRET"])
@pytest.mark.parametrize("value", [None, "", "   ", 123])
def test_invalid_credentials_fail_at_startup(
    configured_settings: tuple[dict[str, Any], Path], key: str, value: object
) -> None:
    raw, path = configured_settings
    raw["LITELLM"][key] = value
    path.write_text(json.dumps(raw))
    with pytest.raises(config.ConfigurationError, match=f"config.LITELLM.{key}"):
        config.get_settings()


def test_proxy_uses_config_not_environment(
    configured_settings: tuple[dict[str, Any], Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("LITELLM_SERVICE_TOKEN", "wrong-environment-token")
    monkeypatch.setenv("LITELLM_IDENTITY_SECRET", "wrong-environment-secret")

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
            return user

        monkeypatch.setattr(litellm, "authenticate_identity", authenticate)
        seen = []

        def upstream(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return httpx.Response(200, json={"data": []})

        app = FastAPI()
        settings = config.get_settings().litellm
        app.mount("/litellm", litellm.LiteLLMProxy(settings))
        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as upstream_client:
            app.state.litellm_proxy_client = upstream_client
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://backend.test"
            ) as client:
                response = await client.get("/litellm/v1/models", headers={"Authorization": "Bearer session"})
        assert response.status_code == 200
        assert len(seen) == 1
        request = seen[0]
        assert str(request.url) == "http://localhost:4000/v1/models"
        assert request.headers["authorization"] == "Bearer configured-service-token"
        payload, signature = request.headers["x-auth-context"].split(".")
        actual = base64.urlsafe_b64decode(signature + "=" * (-len(signature) % 4))
        expected = hmac.new(b"configured-signing-secret", payload.encode(), hashlib.sha256).digest()
        assert hmac.compare_digest(actual, expected)

    asyncio.run(run())
