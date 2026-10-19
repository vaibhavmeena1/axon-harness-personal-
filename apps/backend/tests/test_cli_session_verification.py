"""Startup refresh keeps usable sessions and projects credentials only through a safe header."""

import asyncio

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.clients.auth_service import AUTH_SERVICE_CLIENT_STATE_KEY, AuthServiceClient
from app.core.config import AuthServiceSettings
from app.routers.browser_login import router


@pytest.mark.parametrize(
    "refresh_expired,payload,expected_status,rotation",
    [
        (True, {"status": "VERIFIED"}, "VERIFIED", None),
        (True, {"status": "EXPIRED", "encrypted_session_data": "rotated-secret"}, "VERIFIED", "rotated-secret"),
        (True, {"status": "VERIFIED", "encrypted_session_data": "rotated-secret"}, "VERIFIED", "rotated-secret"),
        (True, {"status": "EXPIRED"}, "EXPIRED", None),
        (True, {"status": "NOT_VERIFIED"}, "NOT_VERIFIED", None),
        (True, {"status": "NOT_VERIFIED", "encrypted_session_data": "rotated-secret"}, "NOT_VERIFIED", None),
        (False, {"status": "VERIFIED"}, "VERIFIED", None),
        (False, {"status": "EXPIRED", "encrypted_session_data": "rotated-secret"}, "EXPIRED", None),
    ],
)
def test_cli_verification_refresh_contract(
    refresh_expired: bool, payload: dict, expected_status: str, rotation: str | None
) -> None:
    seen: list[httpx.Request] = []

    def service(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={**payload, "user_email": "private@example.com", "error_message": "private"})

    auth = AuthServiceClient(AuthServiceSettings("https://auth.test/", "https://login.test/external-auth", 1, 1))
    asyncio.run(auth._client.aclose())
    auth._client = httpx.AsyncClient(base_url="https://auth.test/", transport=httpx.MockTransport(service))
    app = FastAPI()
    app.include_router(router)
    setattr(app.state, AUTH_SERVICE_CLIENT_STATE_KEY, auth)
    try:
        with TestClient(app) as client:
            response = client.post(
                "/api/v1/auth/verify-auth-token",
                params={"refresh_expired": "true"} if refresh_expired else {},
                headers={"Authorization": "Bearer saved-secret"},
            )
        assert response.status_code == 200
        assert response.json() == {"status": expected_status}
        assert response.headers.get("x-session-refresh-token") == rotation
        assert response.headers["cache-control"] == "no-store"
        assert len(seen) == 1
        assert seen[0].method == "POST"
        assert seen[0].url.path == "/v2/verify-auth-token"
        assert dict(seen[0].url.params) == {"refresh_expired": str(refresh_expired).lower()}
        assert seen[0].headers["authorization"] == "Bearer saved-secret"
        assert "private" not in response.text
        assert "secret" not in response.text
    finally:
        asyncio.run(auth.close())


@pytest.mark.parametrize(
    "upstream_status,payload,expected_status",
    [
        (200, {"status": "EXPIRED", "encrypted_session_data": "unsafe\r\nheader"}, 503),
        (200, {"status": "EXPIRED", "encrypted_session_data": ""}, 503),
        (200, {"status": "EXPIRED", "encrypted_session_data": 123}, 503),
        (200, {"status": "unknown"}, 503),
        (200, [], 503),
        (401, {"detail": "private-secret"}, 401),
        (403, {"detail": "private-secret"}, 403),
        (500, {"detail": "private-secret"}, 503),
    ],
)
def test_cli_verification_errors_never_expose_credentials(
    upstream_status: int, payload: object, expected_status: int
) -> None:
    auth = AuthServiceClient(AuthServiceSettings("https://auth.test/", "https://login.test/external-auth", 1, 1))
    asyncio.run(auth._client.aclose())
    auth._client = httpx.AsyncClient(
        base_url="https://auth.test/",
        transport=httpx.MockTransport(lambda _request: httpx.Response(upstream_status, json=payload)),
    )
    app = FastAPI()
    app.include_router(router)
    setattr(app.state, AUTH_SERVICE_CLIENT_STATE_KEY, auth)
    try:
        with TestClient(app) as client:
            response = client.post(
                "/api/v1/auth/verify-auth-token?refresh_expired=true",
                headers={"Authorization": "Bearer saved-secret"},
            )
        assert response.status_code == expected_status
        assert response.headers["cache-control"] == "no-store"
        assert "x-session-refresh-token" not in response.headers
        assert "secret" not in response.text
        assert "encrypted_session_data" not in response.text
    finally:
        asyncio.run(auth.close())
