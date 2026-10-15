"""LiteLLM diagnostics expose failure stages, not sessions, keys, or payloads."""

import asyncio
import logging
from collections.abc import AsyncIterator
from dataclasses import replace
from unittest.mock import AsyncMock
from uuid import UUID

import httpx
import pytest
from fastapi import FastAPI, Request
from starlette.types import Message

from app import authentication
from app.clients.auth_service import AuthenticatedUser, AuthServiceError
from app.clients.litellm.identity import LiteLLMIdentityClient, LiteLLMIdentityError
from app.clients.litellm.transport import LiteLLMTransport
from app.core.config import LiteLLMSettings
from app.proxies.litellm import LiteLLMProxy, mount_litellm_proxy
from app.proxies.litellm_common import LiteLLMRequestLoggingMiddleware

LOGGER = "app.proxies.litellm"


@pytest.fixture
def app(monkeypatch: pytest.MonkeyPatch) -> FastAPI:
    application = FastAPI()
    application.state.litellm_transport = AsyncMock(spec=LiteLLMTransport)
    identity = AsyncMock(spec=LiteLLMIdentityClient)
    identity.settings = LiteLLMSettings(
        upstream_url="http://litellm.test",
        upstream_root_path="/",
        connect_timeout_seconds=10,
        pool_timeout_seconds=10,
        max_connections=10,
        max_keepalive_connections=5,
        keepalive_expiry_seconds=5,
        api_key="secret-admin-key",
        identity_sync_enabled=True,
    )
    identity.authenticated_key.return_value = "secret-native-key"
    application.state.litellm_identity_client = identity

    async def authenticate(request: Request) -> AuthenticatedUser:
        user = AuthenticatedUser(
            user_team_id=12,
            team_id=34,
            user_email="secret-email@example.test",
            organization_name="test",
            role="member",
        )
        request.state.authenticated_user = user
        return user

    monkeypatch.setattr(authentication, "authenticate_identity", authenticate)
    mount_litellm_proxy(application)
    return application


async def request(app: FastAPI, path: str = "/litellm/key/info", request_id: str = "test-request-id") -> httpx.Response:
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://backend.test") as client:
        return await client.post(
            path,
            headers={"Authorization": "Bearer secret-session", "x-request-id": request_id},
            content=b"secret-request-body",
        )


def diagnostic_record(caplog: pytest.LogCaptureFixture) -> logging.LogRecord:
    records = [
        record
        for record in caplog.records
        if record.name == LOGGER and record.getMessage().startswith("LiteLLM request ")
    ]
    assert len(records) == 1
    record = records[0]
    assert "secret" not in record.getMessage()
    assert record.exc_info is None
    assert "duration_ms=" in record.getMessage()
    return record


@pytest.mark.parametrize(
    ("upstream_status", "status", "reason"),
    [
        (200, 200, "none"),
        (401, 403, "upstream_authentication_failed"),
        (403, 403, "upstream_permission_denied"),
        (429, 429, "upstream_http_error"),
        (500, 500, "upstream_http_error"),
    ],
)
def test_upstream_status_and_correlation(
    app: FastAPI, caplog: pytest.LogCaptureFixture, upstream_status: int, status: int, reason: str
) -> None:
    caplog.set_level(logging.INFO, logger=LOGGER)
    app.state.litellm_transport.send_stream.return_value = httpx.Response(
        upstream_status, content=b"secret-upstream-body", headers={"x-request-id": "secret-upstream-id"}
    )
    response = asyncio.run(request(app, "/litellm/key/info?key=secret-query-key"))
    assert response.status_code == status
    assert response.headers["x-request-id"] == "test-request-id"
    headers = dict(app.state.litellm_transport.send_stream.call_args.kwargs["headers"])
    assert headers[b"x-request-id"] == b"test-request-id"
    record = diagnostic_record(caplog)
    message = record.getMessage()
    assert record.levelno == (logging.INFO if status == 200 else logging.WARNING)
    for field in (
        "request_id=test-request-id",
        "path=/key/info",
        "stage=upstream",
        f"reason={reason}",
        f"upstream_status={upstream_status}",
        f"status={status}",
        "credential_mode=virtual_key",
        "completed=true",
    ):
        assert field in message


@pytest.mark.parametrize("status", [401, 403, 503])
def test_session_auth_failures_are_distinct(
    app: FastAPI, caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch, status: int
) -> None:
    caplog.set_level(logging.INFO, logger=LOGGER)

    async def authenticate(request: Request) -> AuthenticatedUser:
        raise AuthServiceError("secret-auth-detail", status_code=status)

    monkeypatch.setattr(authentication, "authenticate_identity", authenticate)
    response = asyncio.run(request(app))
    assert response.status_code == status
    assert response.headers["x-request-id"] == "test-request-id"
    app.state.litellm_transport.send_stream.assert_not_awaited()
    app.state.litellm_identity_client.authenticated_key.assert_not_awaited()
    message = diagnostic_record(caplog).getMessage()
    assert "stage=session_auth reason=session_auth_failed upstream_status=none" in message
    assert "credential_mode=unresolved" in message


@pytest.mark.parametrize(("status", "upstream_status"), [(403, None), (503, 401)])
def test_identity_sync_failures(
    app: FastAPI, caplog: pytest.LogCaptureFixture, status: int, upstream_status: int | None
) -> None:
    caplog.set_level(logging.INFO, logger=LOGGER)
    app.state.litellm_identity_client.authenticated_key.side_effect = LiteLLMIdentityError(
        "secret-management-detail", status_code=status, upstream_status_code=upstream_status
    )
    response = asyncio.run(request(app))
    assert response.status_code == status
    assert response.headers["x-request-id"] == "test-request-id"
    app.state.litellm_transport.send_stream.assert_not_awaited()
    message = diagnostic_record(caplog).getMessage()
    assert "stage=identity_sync reason=identity_sync_failed" in message
    assert f"upstream_status={upstream_status if upstream_status is not None else 'none'}" in message
    assert "error_type=LiteLLMIdentityError" in message


@pytest.mark.parametrize(
    ("state_key", "reason"),
    [
        ("litellm_transport", "transport_not_initialized"),
        ("litellm_identity_client", "identity_client_not_initialized"),
    ],
)
def test_proxy_readiness_failures(app: FastAPI, caplog: pytest.LogCaptureFixture, state_key: str, reason: str) -> None:
    caplog.set_level(logging.INFO, logger=LOGGER)
    setattr(app.state, state_key, None)
    response = asyncio.run(request(app))
    assert response.status_code == 503
    assert response.headers["x-request-id"] == "test-request-id"
    message = diagnostic_record(caplog).getMessage()
    assert f"stage=proxy reason={reason}" in message
    assert "upstream_status=none" in message


@pytest.mark.parametrize("error", [httpx.ConnectError, httpx.ReadTimeout])
def test_transport_failures_do_not_log_exception_urls(
    app: FastAPI, caplog: pytest.LogCaptureFixture, error: type[httpx.HTTPError]
) -> None:
    caplog.set_level(logging.INFO, logger=LOGGER)
    app.state.litellm_transport.send_stream.side_effect = error("secret URL http://litellm.test?key=secret-key")
    response = asyncio.run(request(app))
    assert response.status_code == 502
    assert response.headers["x-request-id"] == "test-request-id"
    message = diagnostic_record(caplog).getMessage()
    assert "stage=upstream reason=upstream_transport_failed upstream_status=none status=502" in message
    assert f"error_type={error.__name__}" in message


@pytest.mark.parametrize(
    "path", ["/litellm", "/litellm/model/info", "/litellm/team/info", "/litellm/files/secret-path-id"]
)
def test_safe_paths_request_ids_and_configured_key_mode(
    app: FastAPI, caplog: pytest.LogCaptureFixture, path: str
) -> None:
    caplog.set_level(logging.INFO, logger=LOGGER)
    identity = app.state.litellm_identity_client
    identity.settings = replace(identity.settings, identity_sync_enabled=False)
    app.state.litellm_transport.send_stream.return_value = httpx.Response(200, content=b"ok")
    response = asyncio.run(request(app, path, request_id="secret id with spaces"))
    assert response.status_code == 200
    UUID(response.headers["x-request-id"])
    record = diagnostic_record(caplog)
    message = record.getMessage()
    assert f"request_id={response.headers['x-request-id']}" in message
    assert "credential_mode=configured_key" in message
    expected_path = {"/litellm": "/", "/litellm/model/info": "/model/info", "/litellm/team/info": "/team/info"}.get(
        path, "<other>"
    )
    assert f"path={expected_path}" in message


@pytest.mark.parametrize("failure", ["upstream", "cancelled", "disconnected"])
def test_stream_failures_preserve_status_and_cleanup(
    app: FastAPI, caplog: pytest.LogCaptureFixture, failure: str
) -> None:
    caplog.set_level(logging.INFO, logger=LOGGER)

    class Stream(httpx.AsyncByteStream):
        closed = False

        async def __aiter__(self) -> AsyncIterator[bytes]:
            yield b"secret-stream-body"
            raise httpx.ReadError("secret-stream-error")

        async def aclose(self) -> None:
            self.closed = True

    async def run() -> None:
        stream = Stream()
        app.state.litellm_transport.send_stream.return_value = httpx.Response(200, stream=stream)
        scope = {
            "type": "http",
            "method": "POST",
            "path": "/litellm/v1/chat/completions",
            "root_path": "/litellm",
            "headers": [(b"x-request-id", b"test-request-id")],
            "state": {
                "authenticated_user": AuthenticatedUser(
                    user_team_id=12,
                    team_id=34,
                    user_email="secret@example.test",
                    organization_name="test",
                    role="member",
                ),
                "encrypted_session_data": "secret-session",
            },
            "app": app,
        }
        messages = []

        async def receive() -> Message:
            return {"type": "http.request", "body": b""}

        async def send(message: Message) -> None:
            messages.append(message)
            if message.get("body"):
                if failure == "cancelled":
                    raise asyncio.CancelledError
                if failure == "disconnected":
                    raise OSError("secret-disconnect-detail")

        proxy = LiteLLMRequestLoggingMiddleware(LiteLLMProxy(), logger=logging.getLogger(LOGGER))
        if failure == "disconnected":
            await proxy(scope, receive, send)
        else:
            with pytest.raises(httpx.ReadError if failure == "upstream" else asyncio.CancelledError):
                await proxy(scope, receive, send)
        assert messages[0]["status"] == 200
        assert stream.closed

    asyncio.run(run())
    record = diagnostic_record(caplog)
    message = record.getMessage()
    assert "upstream_status=200 status=200" in message
    assert "completed=false" in message
    expected_reason = {
        "upstream": "upstream_stream_failed",
        "cancelled": "request_cancelled",
        "disconnected": "client_disconnected",
    }[failure]
    assert f"reason={expected_reason}" in message
    assert record.levelno == (logging.WARNING if failure == "upstream" else logging.INFO)
