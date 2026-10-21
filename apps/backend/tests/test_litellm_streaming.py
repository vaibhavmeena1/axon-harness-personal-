"""ASGI proxy streaming, header security, and response cleanup survive the boundary."""

import asyncio
import gzip
from collections.abc import AsyncIterator
from unittest.mock import AsyncMock
from urllib.parse import unquote

import httpx
import pytest
from fastapi import FastAPI
from starlette.types import Message, Scope

from app.clients.auth_service import AuthenticatedUser
from app.clients.litellm.identity import LiteLLMIdentityClient, LiteLLMIdentityError
from app.clients.litellm.transport import LiteLLMTransport
from app.core.config import LiteLLMSettings
from app.proxies.litellm import LiteLLMProxy
from app.proxies.litellm_common import LiteLLMRequestLoggingMiddleware


class UpstreamStream(httpx.AsyncByteStream):
    def __init__(self) -> None:
        wire = gzip.compress(b"data: first\n\ndata: second\n\n")
        self.chunks = [wire[:10], wire[10:]]
        self.reads = 0
        self.closed = False

    async def __aiter__(self) -> AsyncIterator[bytes]:
        for chunk in self.chunks:
            self.reads += 1
            yield chunk

    async def aclose(self) -> None:
        self.closed = True


def verified_scope(app: FastAPI) -> Scope:
    user = AuthenticatedUser(
        user_id=12,
        user_email="dev@example.test",
        session_refresh_token="trusted-refresh",
    )
    return {
        "type": "http",
        "method": "POST",
        "path": "/edge/litellm/v1/a/b",
        "raw_path": b"/edge/litellm/v1/a%2Fb",
        "root_path": "/edge/litellm",
        "query_string": b"q=a%2Bb&q=c",
        "headers": [
            (b"authorization", b"Bearer untrusted-session"),
            (b"cookie", b"secret"),
            (b"x-litellm-end-user-id", b"spoofed-user"),
            (b"x-litellm-api-key", b"spoofed-key"),
            (b"x-auth-context", b"spoofed-identity"),
            (b"connection", b"x-remove"),
            (b"x-remove", b"hop-by-hop"),
            (b"x-request-id", b"trusted-request-id"),
            (b"x-custom", b"one"),
            (b"x-custom", b"two"),
        ],
        "state": {"authenticated_user": user, "encrypted_session_data": "verified-session"},
        "app": app,
    }


def test_proxy_forwards_raw_chunks_and_closes_on_cancellation() -> None:
    async def run(cancel: bool) -> None:
        settings = LiteLLMSettings(
            upstream_url="http://litellm.test",
            upstream_root_path="/private",
            connect_timeout_seconds=10,
            pool_timeout_seconds=10,
            max_connections=10,
            max_keepalive_connections=5,
            keepalive_expiry_seconds=5,
            api_key="admin-key",
        )
        stream = UpstreamStream()
        seen: list[httpx.Request] = []
        body_chunks: list[bytes] = []
        received = 0

        async def upstream(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            assert received == 1
            async for chunk in request.stream:
                body_chunks.append(chunk)
                # The next ASGI frame is not read ahead of this upstream write.
                assert received == len(body_chunks)
            return httpx.Response(
                200,
                stream=stream,
                headers=[
                    ("content-type", "text/event-stream"),
                    ("content-encoding", "gzip"),
                    ("set-cookie", "secret"),
                    ("authorization", "secret"),
                    ("x-session-refresh-token", "untrusted-refresh"),
                    ("x-request-id", "untrusted-request-id"),
                    ("cache-control", "public"),
                    ("connection", "x-remove"),
                    ("x-remove", "hop-by-hop"),
                    ("x-custom", "one"),
                    ("x-custom", "two"),
                ],
            )

        class StreamingTransport(httpx.AsyncBaseTransport):
            async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
                return await upstream(request)

        client = httpx.AsyncClient(transport=StreamingTransport())
        transport = LiteLLMTransport(settings, client=client)
        app = FastAPI()
        app.state.litellm_transport = transport
        identity = AsyncMock(spec=LiteLLMIdentityClient)
        identity.authenticated_key.return_value = "native-key"
        app.state.litellm_identity_client = identity
        scope = verified_scope(app)
        messages: list[Message] = []
        request_chunks = iter(
            [
                {"type": "http.request", "body": b"first ", "more_body": True},
                {"type": "http.request", "body": b"second", "more_body": False},
            ]
        )

        async def receive() -> Message:
            nonlocal received
            received += 1
            return next(request_chunks)

        async def send(message: Message) -> None:
            messages.append(message)
            # No chunks may be read ahead of downstream headers/body writes.
            assert stream.reads == sum(bool(item.get("body")) for item in messages)
            if cancel and message.get("body"):
                raise asyncio.CancelledError

        try:
            if cancel:
                with pytest.raises(asyncio.CancelledError):
                    await LiteLLMRequestLoggingMiddleware(LiteLLMProxy())(scope, receive, send)
            else:
                await LiteLLMRequestLoggingMiddleware(LiteLLMProxy())(scope, receive, send)
        finally:
            await transport.aclose()
        assert stream.closed
        request = seen[0]
        assert str(request.url) == "http://litellm.test/private/v1/a%2Fb?q=a%2Bb&q=c"
        assert body_chunks == [b"first ", b"second"]
        assert request.headers["authorization"] == "Bearer native-key"
        assert request.headers["x-litellm-end-user-id"] == "12"
        assert request.headers.get_list("x-custom") == ["one", "two"]
        assert {"cookie", "x-litellm-api-key", "x-auth-context", "x-remove"}.isdisjoint(request.headers)
        response_headers = httpx.Headers(messages[0]["headers"])
        assert response_headers["cache-control"] == "no-store"
        assert response_headers["x-request-id"] == "trusted-request-id"
        assert response_headers["x-session-refresh-token"] == "trusted-refresh"
        assert response_headers.get_list("x-custom") == ["one", "two"]
        assert {"set-cookie", "authorization", "x-remove", "connection"}.isdisjoint(response_headers)
        if not cancel:
            assert [message["body"] for message in messages[1:-1]] == stream.chunks
            assert messages[-1] == {"type": "http.response.body", "body": b"", "more_body": False}

    asyncio.run(run(False))
    asyncio.run(run(True))


@pytest.mark.parametrize("failure", ["unauthenticated", "identity-missing", "identity-blocked", "identity-unavailable"])
def test_proxy_failures_never_forward_model_traffic(failure: str) -> None:
    async def run() -> None:
        app = FastAPI()
        transport = AsyncMock(spec=LiteLLMTransport)
        app.state.litellm_transport = transport
        identity = AsyncMock(spec=LiteLLMIdentityClient)
        app.state.litellm_identity_client = identity
        scope = verified_scope(app)
        status = 503
        if failure == "unauthenticated":
            scope["state"] = {}
            status = 401
        elif failure == "identity-missing":
            app.state.litellm_identity_client = None
        else:
            status = 403 if failure == "identity-blocked" else 503
            identity.authenticated_key.side_effect = LiteLLMIdentityError("secret upstream detail", status_code=status)
        messages: list[Message] = []

        async def receive() -> Message:
            return {"type": "http.request", "body": b""}

        async def send(message: Message) -> None:
            messages.append(message)

        await LiteLLMProxy()(scope, receive, send)
        assert messages[0]["status"] == status
        assert b"secret" not in messages[1]["body"]
        assert httpx.Headers(messages[0]["headers"])["cache-control"] == "no-store"
        transport.send_stream.assert_not_awaited()

    asyncio.run(run())


@pytest.mark.parametrize(
    "raw_path",
    [
        b"/.",
        b"/../../other/x",
        b"/v1/./models",
        b"/v1/../models",
        b"/v1/%2e/models",
        b"/%2e%2e/%2E%2E/other/x",
        b"/.%2e/%2e./other/x",
        b"/%2e%2e%2f%2e%2e%2fother/x",
        b"/%252e%252e%252fother/x",
    ],
)
@pytest.mark.parametrize("include_raw_path", [True, False])
def test_proxy_rejects_dot_segments_before_credentials_or_body(raw_path: bytes, include_raw_path: bool) -> None:
    async def run() -> None:
        app = FastAPI()
        transport = AsyncMock(spec=LiteLLMTransport)
        transport.send_stream.return_value = httpx.Response(200, content=b"upstream")
        app.state.litellm_transport = transport
        identity = AsyncMock(spec=LiteLLMIdentityClient)
        identity.authenticated_key.return_value = "backend-only-key"
        app.state.litellm_identity_client = identity
        scope = verified_scope(app)
        # Inject an ASGI path directly: an HTTPX test client normalizes literal
        # dot segments before the request can reach the mounted proxy.
        scope["path"] = "/edge/litellm" + unquote(raw_path.decode("ascii"))
        scope["raw_path"] = b"/edge/litellm" + raw_path
        if not include_raw_path:
            scope.pop("raw_path")
        receive = AsyncMock(return_value={"type": "http.request", "body": b""})
        messages: list[Message] = []

        async def send(message: Message) -> None:
            messages.append(message)

        await LiteLLMRequestLoggingMiddleware(LiteLLMProxy())(scope, receive, send)
        assert messages[0]["status"] == 400
        assert messages[1]["body"] == b'{"detail":"Invalid LiteLLM request path"}'
        response_headers = httpx.Headers(messages[0]["headers"])
        assert response_headers["cache-control"] == "no-store"
        assert response_headers["x-request-id"] == "trusted-request-id"
        identity.authenticated_key.assert_not_awaited()
        transport.send_stream.assert_not_awaited()
        receive.assert_not_awaited()

    asyncio.run(run())


@pytest.mark.parametrize("status", [401, 403])
def test_upstream_key_denials_are_sanitized_and_closed(status: int) -> None:
    async def run() -> None:
        app = FastAPI()
        stream = UpstreamStream()
        response = httpx.Response(status, stream=stream)
        transport = AsyncMock(spec=LiteLLMTransport)
        transport.send_stream.return_value = response
        app.state.litellm_transport = transport
        identity = AsyncMock(spec=LiteLLMIdentityClient)
        identity.authenticated_key.return_value = "native-key"
        app.state.litellm_identity_client = identity
        messages: list[Message] = []

        async def receive() -> Message:
            return {"type": "http.request", "body": b""}

        async def send(message: Message) -> None:
            messages.append(message)

        await LiteLLMProxy()(verified_scope(app), receive, send)
        assert messages[0]["status"] == 403
        assert messages[1]["body"] == b'{"detail":"LiteLLM access denied"}'
        assert stream.reads == 0
        assert stream.closed

    asyncio.run(run())
