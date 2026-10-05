"""API guards, non-reflective metadata errors and private cache behavior."""

from uuid import uuid4

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app.authentication import require_authenticated_user
from app.clients.auth_service import AuthData
from app.routers.sessions import _upload_rates, router, service


class RouteService:
    def __init__(self) -> None:
        self.owner = None

    async def register(self, owner: int, declaration: object) -> dict:
        self.owner = owner
        return {"registered": True}

    async def download(self, session_id: object, owner: int) -> dict:
        raise HTTPException(404, "Session not found", headers={"Cache-Control": "no-store"})


def client(authenticated: bool = True) -> tuple[TestClient, RouteService]:
    app = FastAPI()
    app.include_router(router)
    fake = RouteService()
    app.dependency_overrides[service] = lambda: fake
    if authenticated:
        app.dependency_overrides[require_authenticated_user] = lambda: AuthData(user_team_id=123)
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


def test_verified_owner_not_caller_fields_and_no_error_reflection() -> None:
    api, fake = client()
    response = api.post("/api/v1/sessions", json=registration())
    assert response.status_code == 200 and fake.owner == 123
    invalid = api.post(
        "/api/v1/sessions", json={**registration(), "owner_user_team_id": 999, "secret": "never-reflect-this"}
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


def test_upload_rate_limit_is_owner_scoped() -> None:
    api, _ = client()
    for _ in range(30):
        assert api.post("/api/v1/sessions", json=registration()).status_code == 200
    response = api.post("/api/v1/sessions", json=registration())
    assert response.status_code == 429 and response.headers["retry-after"] == "60"
