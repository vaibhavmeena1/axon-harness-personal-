"""API guards, non-reflective metadata errors and private cache behavior."""

import asyncio
from types import SimpleNamespace
from uuid import uuid4

import httpx
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app.authentication import require_authenticated_user
from app.clients.auth_service import AuthData, AuthServiceClient
from app.core.config import AuthServiceSettings, get_settings
from app.routers.sessions import _upload_rates, router
from app.services.storage_dependencies import get_backup_service


class RouteService:
    def __init__(self) -> None:
        self.owner = None

    async def ready(self) -> None:
        pass

    async def register(self, owner: int, declaration: object) -> dict:
        self.owner = owner
        return {"registered": True}

    async def download(self, session_id: object, owner: int) -> dict:
        raise HTTPException(404, "Session not found", headers={"Cache-Control": "no-store"})


def client(authenticated: bool = True) -> tuple[TestClient, RouteService]:
    app = FastAPI()
    app.include_router(router)
    fake = RouteService()
    app.state.backup_service = fake
    app.dependency_overrides[get_settings] = lambda: SimpleNamespace(session_backups=object())
    app.dependency_overrides[get_backup_service] = lambda: fake
    if authenticated:
        app.dependency_overrides[require_authenticated_user] = lambda: AuthData(user_id=123)
    _upload_rates.clear()
    return TestClient(app), fake


def registration() -> dict:
    return {
        "client_session_key": str(uuid4()),
        "device_id": str(uuid4()),
        "harness": "pi",
        "harness_session_id": "opaque",
        "session_format": "pi-jsonl",
    }


def test_all_routes_require_authentication() -> None:
    api, _ = client(False)
    for method, path, body in [
        ("GET", "/status", None),
        ("POST", "", registration()),
        ("GET", "", None),
        ("GET", f"/{uuid4()}/backup-download", None),
        ("DELETE", f"/{uuid4()}", None),
    ]:
        response = api.request(method, "/api/v1/sessions" + path, json=body)
        assert response.status_code == 401
        assert response.headers["cache-control"] == "no-store"


def test_status_advertises_administrator_policy_and_verified_owner() -> None:
    api, _ = client()
    response = api.get("/api/v1/sessions/status")
    assert response.status_code == 200
    assert response.json()["enabled"] is True
    assert response.json()["owner_user_id"] == "123"
    api.app.dependency_overrides[get_settings] = lambda: SimpleNamespace(session_backups=None)
    response = api.get("/api/v1/sessions/status")
    assert response.status_code == 200
    assert response.json() == {"enabled": False, "owner_user_id": "123"}
    assert response.headers["cache-control"] == "no-store"
    # Unlike policy discovery, data operations remain unavailable when disabled.
    api.app.dependency_overrides.pop(get_backup_service)
    assert api.post("/api/v1/sessions", json=registration()).status_code == 503


def test_verified_owner_not_caller_fields_and_no_error_reflection() -> None:
    api, fake = client()
    response = api.post("/api/v1/sessions", json=registration())
    assert response.status_code == 200 and fake.owner == 123
    invalid = api.post(
        "/api/v1/sessions", json={**registration(), "owner_user_id": 999, "secret": "never-reflect-this"}
    )
    assert invalid.status_code == 422
    assert "never-reflect-this" not in invalid.text
    assert invalid.headers["cache-control"] == "no-store"
    large = api.post(
        "/api/v1/sessions", content='{"fragment":"' + "x" * 17000 + '"}', headers={"content-type": "application/json"}
    )
    assert large.status_code == 413 and large.headers["cache-control"] == "no-store"
    other = api.get(f"/api/v1/sessions/{uuid4()}/backup-download")
    assert other.status_code == 404


@pytest.mark.parametrize(
    "auth_status,auth_data,expected",
    [
        (200, {"user_team_id": 9876543210, "user_id": 42, "team_id": 99}, 200),
        (200, {"user_id": 42}, 200),
        (200, {"user_team_id": 9876543210, "team_id": 99}, 503),
        *[(200, {"user_id": invalid, "user_team_id": 12}, 503) for invalid in [None, True, 0, -1, "42", 1.5, 2**63]],
        (401, {}, 401),
        (403, {}, 403),
        (500, {}, 503),
    ],
)
def test_session_owner_is_extracted_through_auth_service(auth_status: int, auth_data: dict, expected: int) -> None:
    async def check() -> None:
        api, fake = client(False)
        seen = []

        def service(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return httpx.Response(auth_status, json={"auth_data": auth_data, "response_headers": {}})

        auth = AuthServiceClient(AuthServiceSettings("https://auth.test/", "https://login.test/", 1, 1))
        await auth._client.aclose()
        auth._client = httpx.AsyncClient(base_url="https://auth.test/", transport=httpx.MockTransport(service))
        api.app.state.auth_service_client = auth
        try:
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=api.app), base_url="https://backend.test/"
            ) as http:
                headers = {"Authorization": "Bearer verified-session", "X-User-Team-Id": "999"}
                status = await http.get("/api/v1/sessions/status?owner_user_id=999", headers=headers)
                registered = await http.post("/api/v1/sessions", json=registration(), headers=headers)
                assert status.status_code == registered.status_code == expected
                assert status.headers["cache-control"] == registered.headers["cache-control"] == "no-store"
                if expected == 200:
                    assert status.json()["owner_user_id"] == "42"
                    assert fake.owner == 42
                else:
                    assert fake.owner is None
            assert len(seen) == 2
            for request in seen:
                assert request.method == "GET"
                assert request.url.path == "/v2/get-auth-data"
                assert request.headers["Authorization"] == "Bearer verified-session"
                assert "X-User-Team-Id" not in request.headers
                assert "owner_user_id" not in request.url.params
        finally:
            await auth.close()

    asyncio.run(check())


def test_upload_rate_limit_is_owner_scoped() -> None:
    api, _ = client()
    for _ in range(30):
        assert api.post("/api/v1/sessions", json=registration()).status_code == 200
    response = api.post("/api/v1/sessions", json=registration())
    assert response.status_code == 429 and response.headers["retry-after"] == "60"
