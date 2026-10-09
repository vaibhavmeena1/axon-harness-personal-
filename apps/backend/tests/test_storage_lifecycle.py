"""Storage ownership, request reuse, readiness and failure cleanup without AWS calls."""

import asyncio
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import listeners
from app.authentication import require_authenticated_user
from app.clients.auth_service import AuthData
from app.clients.s3 import S3Client
from app.core.config import get_settings
from app.core.s3 import S3ClientSettings, S3StorageSettings
from app.core.session_storage import SessionStorageSettings
from app.listeners import storage
from app.routers.cli_releases import router as release_router
from app.routers.sessions import router as session_router
from tests.test_cli_releases import VERSION, release_settings


def fake_clients(monkeypatch: pytest.MonkeyPatch) -> list[S3Client]:
    clients = []

    def create(settings: S3ClientSettings) -> S3Client:
        sdk = Mock()
        sdk.generate_presigned_url.return_value = "https://objects.example.test/signed"
        sdk.get_bucket_versioning.return_value = {}
        sdk.get_bucket_lifecycle_configuration.return_value = {"Rules": []}
        sdk.get_public_access_block.return_value = {
            "PublicAccessBlockConfiguration": dict.fromkeys(
                ["BlockPublicAcls", "IgnorePublicAcls", "BlockPublicPolicy", "RestrictPublicBuckets"], True
            )
        }
        client = S3Client(settings, client=sdk)
        clients.append(client)
        return client

    monkeypatch.setattr(storage, "S3Client", create)
    return clients


def settings_for(releases: bool = True, backups: bool = True) -> SimpleNamespace:
    return SimpleNamespace(
        cli_releases=release_settings() if releases else None,
        session_backups=SessionStorageSettings(
            S3StorageSettings("private-sessions", S3ClientSettings("ap-south-1")), require_create_only_policy=False
        )
        if backups
        else None,
        auth_service=None,
    )


def app_for(settings: SimpleNamespace) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):  # noqa: ANN202 - test async context manager
        await storage.initialize_storage(app)
        try:
            yield
        finally:
            await storage.close_storage(app)

    app = FastAPI(lifespan=lifespan)
    app.include_router(release_router)
    app.include_router(session_router)
    app.dependency_overrides[get_settings] = lambda: settings
    app.dependency_overrides[require_authenticated_user] = lambda: AuthData(user_team_id=123)
    return app


def test_requests_reuse_separate_clients_and_shutdown_closes_them(monkeypatch: pytest.MonkeyPatch) -> None:
    clients = fake_clients(monkeypatch)
    settings = settings_for()
    monkeypatch.setattr(storage, "get_settings", lambda: settings)
    app = app_for(settings)
    with TestClient(app, follow_redirects=False) as api:
        assert len(clients) == 2
        release_service = app.state.cli_release_service
        backup_service = app.state.backup_service
        assert release_service.s3 is clients[0]
        assert backup_service.store.s3 is clients[1]
        # Bucket guards remain lazy, not an extra network requirement during startup.
        clients[1].client.get_bucket_versioning.assert_not_called()
        for _ in range(2):
            upload = api.post(
                "/api/v1/cli/releases/uploads/presign",
                json={"version": VERSION},
                headers={"Authorization": f"Bearer {settings.cli_releases.upload_auth_key}"},
            )
            assert upload.status_code == 200
            assert upload.json()["headers"]["If-None-Match"] == "*"
            download = api.get(f"/api/v1/cli/releases/{VERSION}/axon-darwin-arm64.gz")
            assert download.status_code == 302 and "Signature=" in download.headers["location"]
            assert api.get("/api/v1/sessions/status").status_code == 200
            assert app.state.cli_release_service is release_service
            assert app.state.backup_service is backup_service
        assert len(clients) == 2
        assert clients[0].client.generate_presigned_url.call_count == 2
        clients[1].client.get_bucket_versioning.assert_called_once_with(Bucket="private-sessions")
        for client in clients:
            client.client.close.assert_not_called()
    for client in clients:
        client.client.close.assert_called_once_with()
    assert app.state.cli_release_service is None
    assert app.state.backup_service is None
    asyncio.run(storage.close_storage(app))
    for client in clients:
        client.client.close.assert_called_once_with()


@pytest.mark.parametrize(("releases", "backups"), [(False, False), (True, False), (False, True)])
def test_disabled_features_do_not_create_clients(
    monkeypatch: pytest.MonkeyPatch, releases: bool, backups: bool
) -> None:
    clients = fake_clients(monkeypatch)
    settings = settings_for(releases, backups)
    monkeypatch.setattr(storage, "get_settings", lambda: settings)
    with TestClient(app_for(settings)) as api:
        assert len(clients) == int(releases) + int(backups)
        assert api.get("/api/v1/cli/releases/latest").status_code == (200 if releases else 503)
        response = api.get("/api/v1/sessions/status")
        assert response.status_code == 200
        assert response.json()["enabled"] is backups
        assert response.headers["cache-control"] == "no-store"
    for client in clients:
        client.client.close.assert_called_once_with()


def test_application_instances_do_not_share_clients_or_backup_locks(monkeypatch: pytest.MonkeyPatch) -> None:
    clients = fake_clients(monkeypatch)
    settings = settings_for()
    monkeypatch.setattr(storage, "get_settings", lambda: settings)
    first, second = FastAPI(), FastAPI()

    async def check() -> None:
        await storage.initialize_storage(first)
        await storage.initialize_storage(second)
        try:
            assert first.state.backup_service is not second.state.backup_service
            assert first.state.cli_release_service is not second.state.cli_release_service
            await storage.close_storage(first)
            for client in clients[:2]:
                client.client.close.assert_called_once_with()
            for client in clients[2:]:
                client.client.close.assert_not_called()
            await second.state.backup_service.ready()
        finally:
            await storage.close_storage(first)
            await storage.close_storage(second)

    asyncio.run(check())
    for client in clients:
        client.client.close.assert_called_once_with()


def test_partial_startup_failure_closes_already_created_client(monkeypatch: pytest.MonkeyPatch) -> None:
    settings = settings_for()
    monkeypatch.setattr(storage, "get_settings", lambda: settings)
    sdk = Mock()
    s3 = S3Client(S3ClientSettings("ap-south-1"), client=sdk)
    factory = Mock(side_effect=[s3, RuntimeError("Second pool failed")])
    monkeypatch.setattr(storage, "S3Client", factory)
    app = FastAPI()
    with pytest.raises(RuntimeError, match="Second pool failed"):
        asyncio.run(storage.initialize_storage(app))
    sdk.close.assert_called_once_with()
    assert getattr(app.state, "cli_release_service", None) is None
    assert getattr(app.state, "backup_service", None) is None
    asyncio.run(storage.close_storage(app))
    sdk.close.assert_called_once_with()


def test_all_clients_close_even_if_one_shutdown_callback_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    clients = fake_clients(monkeypatch)
    settings = settings_for()
    monkeypatch.setattr(storage, "get_settings", lambda: settings)
    app = FastAPI()

    async def check() -> None:
        await storage.initialize_storage(app)
        clients[1].client.close.side_effect = RuntimeError("Failed to close")
        with pytest.raises(RuntimeError, match="Failed to close"):
            await storage.close_storage(app)
        await storage.close_storage(app)

    asyncio.run(check())
    for client in clients:
        client.client.close.assert_called_once_with()
    assert app.state.cli_release_service is None and app.state.backup_service is None


def test_later_application_startup_failure_closes_storage(monkeypatch: pytest.MonkeyPatch) -> None:
    clients = fake_clients(monkeypatch)
    settings = settings_for()
    monkeypatch.setattr(storage, "get_settings", lambda: settings)
    monkeypatch.setattr(listeners, "get_settings", lambda: settings)
    for name in (
        "initialize_backend_telemetry",
        "close_backend_telemetry",
        "initialize_database",
        "close_database",
        "initialize_litellm_proxy",
        "close_litellm_proxy",
    ):
        monkeypatch.setattr(listeners, name, AsyncMock())
    monkeypatch.setattr(listeners, "initialize_otel_proxy", AsyncMock(side_effect=RuntimeError("Later failure")))
    app = FastAPI()

    async def start() -> None:
        async with listeners.lifespan(app):
            pytest.fail("Startup should have failed")

    with pytest.raises(RuntimeError, match="Later failure"):
        asyncio.run(start())
    assert len(clients) == 2
    for client in clients:
        client.client.close.assert_called_once_with()


@pytest.mark.parametrize("failure", ["missing", "policy"])
def test_backup_dependency_fails_closed_without_exposing_diagnostics(
    monkeypatch: pytest.MonkeyPatch, failure: str
) -> None:
    clients = fake_clients(monkeypatch)
    settings = settings_for(releases=False)
    monkeypatch.setattr(storage, "get_settings", lambda: settings)
    app = app_for(settings)
    with TestClient(app) as api:
        if failure == "missing":
            app.state.backup_service = None
        else:
            clients[0].client.get_bucket_versioning.side_effect = RuntimeError("secret-key-or-signed-url")
        response = api.get("/api/v1/sessions/status")
        assert response.status_code == 503
        assert "secret-key-or-signed-url" not in response.text
        assert response.headers["cache-control"] == "no-store"
    clients[0].client.close.assert_called_once_with()
