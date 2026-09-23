"""Behaviour of the console SPA mount."""

import asyncio
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.web import static as static_module
from app.web.static import (
    IMMUTABLE_CACHE_CONTROL,
    NO_STORE_CACHE_CONTROL,
    SinglePageApplication,
    mount_frontend,
)

INDEX_BODY = "<!doctype html><html><body><div id='root'></div></body></html>"
ASSET_BODY = "console.log('built');"


@pytest.fixture
def build_dir(tmp_path: Path) -> Path:
    """A minimal stand-in for a Vite build directory."""
    (tmp_path / "index.html").write_text(INDEX_BODY)
    (tmp_path / "favicon.svg").write_text("<svg />")
    assets = tmp_path / "assets"
    assets.mkdir()
    (assets / "main-a1b2c3d4.js").write_text(ASSET_BODY)
    return tmp_path


@pytest.fixture
def client(build_dir: Path) -> TestClient:
    """An app shaped like the real one: API routes first, console catch-all last."""
    app = FastAPI()

    @app.get("/api/v1/health/readiness")
    async def readiness() -> dict[str, str]:
        return {"status": "ready"}

    app.mount("/", SinglePageApplication(directory=build_dir), name="console")
    return TestClient(app)


def test_api_routes_are_not_shadowed_by_the_catch_all(client: TestClient) -> None:
    response = client.get("/api/v1/health/readiness")

    assert response.status_code == 200
    assert response.json() == {"status": "ready"}


def test_root_serves_the_index(client: TestClient) -> None:
    response = client.get("/")

    assert response.status_code == 200
    assert response.text == INDEX_BODY


def test_client_side_route_falls_back_to_the_index(client: TestClient) -> None:
    response = client.get("/installations/42")

    assert response.status_code == 200
    assert response.text == INDEX_BODY


def test_the_index_is_never_cached(client: TestClient) -> None:
    for path in ("/", "/index.html", "/installations/42"):
        assert client.get(path).headers["cache-control"] == NO_STORE_CACHE_CONTROL


def test_hashed_assets_are_cached_permanently(client: TestClient) -> None:
    response = client.get("/assets/main-a1b2c3d4.js")

    assert response.status_code == 200
    assert response.text == ASSET_BODY
    assert response.headers["cache-control"] == IMMUTABLE_CACHE_CONTROL


def test_static_files_outside_assets_are_still_served(client: TestClient) -> None:
    response = client.get("/favicon.svg")

    assert response.status_code == 200
    assert response.text == "<svg />"


def test_a_missing_asset_is_a_real_404(client: TestClient) -> None:
    """A stale asset URL must fail loudly instead of returning the index HTML."""
    response = client.get("/assets/main-deadbeef.js")

    assert response.status_code == 404


def test_an_unregistered_api_path_is_a_real_404(client: TestClient) -> None:
    """An unknown endpoint must stay a 404 that an API caller can act on."""
    response = client.get("/api/v1/does-not-exist")

    assert response.status_code == 404


@pytest.mark.parametrize("path", ["assets/main-deadbeef.js", "api/v1/does-not-exist"])
def test_a_404_is_returned_rather_than_raised(build_dir: Path, path: str) -> None:
    """Guards the 404 against Vortex's global HTTPException handler.

    Vortex registers a handler whose legacy status mapping rewrites 404 to 400
    and wraps the body in the API error envelope. Raising here would therefore
    produce a 400 for a missing static file, so the response must be returned.
    """
    app = SinglePageApplication(directory=build_dir)
    scope = {"type": "http", "method": "GET", "headers": []}

    response = asyncio.run(app.get_response(path, scope))

    assert response.status_code == 404


def test_mount_frontend_skips_a_missing_build(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """The backend must still start when the console has not been built."""
    monkeypatch.setattr(
        static_module,
        "get_settings",
        lambda: type("Settings", (), {"frontend_dir": tmp_path / "absent"})(),
    )
    app = FastAPI()

    mount_frontend(app)

    assert not any(route.name == "console" for route in app.routes)


def test_mount_frontend_mounts_an_existing_build(build_dir: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        static_module,
        "get_settings",
        lambda: type("Settings", (), {"frontend_dir": build_dir})(),
    )
    app = FastAPI()

    mount_frontend(app)

    assert TestClient(app).get("/installations/42").text == INDEX_BODY
