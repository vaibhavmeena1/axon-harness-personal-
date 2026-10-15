"""The dashboard uses native LiteLLM auth without granting backend credentials."""

import asyncio
from collections.abc import AsyncIterator
from pathlib import Path
from unittest.mock import AsyncMock
from urllib.parse import unquote

import httpx
import pytest
from fastapi import FastAPI
from starlette.types import Message, Scope

from app import authentication
from app.clients.litellm.identity import LiteLLMIdentityClient
from app.clients.litellm.transport import LiteLLMTransport
from app.core.config import LiteLLMSettings
from app.proxies.litellm import mount_litellm_proxy
from app.proxies.litellm_ui import LiteLLMUIProxy, mount_litellm_ui_proxy
from app.web.static import SinglePageApplication


@pytest.fixture
def settings() -> LiteLLMSettings:
    return LiteLLMSettings(
        upstream_url="http://litellm.test:4000",
        upstream_root_path="/axon/litellm-admin",
        connect_timeout_seconds=10,
        pool_timeout_seconds=10,
        max_connections=10,
        max_keepalive_connections=5,
        keepalive_expiry_seconds=5,
        api_key="backend-master-key",
        identity_sync_enabled=True,
        ui_enabled=True,
    )


@pytest.mark.parametrize("external_root", ["", "/axon"])
@pytest.mark.parametrize(
    "method, path",
    [
        ("GET", "/ui/"),
        ("GET", "/ui/_next/static/chunks/main.js"),
        ("POST", "/login"),
        ("POST", "/logout"),
        ("GET", "/v1/models"),
        ("GET", "/files/a%2Fb?q=a%2Bb&q=c&blank="),
    ],
)
def test_browser_routes_bypass_axon_but_api_stays_protected(
    settings: LiteLLMSettings,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    external_root: str,
    method: str,
    path: str,
) -> None:
    auth = AsyncMock(side_effect=AssertionError("browser requests must not authenticate with Axon"))
    monkeypatch.setattr(authentication, "authenticate_identity", auth)

    async def run() -> None:
        seen: list[httpx.Request] = []

        async def upstream(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            assert await request.aread() == b"browser-payload"
            return httpx.Response(200, content=b"native-ui")

        app = FastAPI(root_path=external_root)
        identity = AsyncMock(spec=LiteLLMIdentityClient)
        app.state.litellm_identity_client = identity
        transport = LiteLLMTransport(settings, client=httpx.AsyncClient(transport=httpx.MockTransport(upstream)))
        app.state.litellm_transport = transport
        mount_litellm_proxy(app)
        mount_litellm_ui_proxy(app)
        (tmp_path / "index.html").write_text("frontend-catch-all")
        app.mount("/", SinglePageApplication(directory=tmp_path))
        try:
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="https://public.test"
            ) as client:
                response = await client.request(
                    method, external_root + "/litellm-admin" + path, content=b"browser-payload"
                )
                assert response.status_code == 200
                assert response.content == b"native-ui"
                assert response.headers["cache-control"] == "no-store"
                assert response.headers["x-request-id"]
                api_response = await client.get(external_root + "/litellm/v1/models")
                assert api_response.status_code == 401
                assert api_response.json() == {"detail": "Authentication required"}
            assert len(seen) == 1
            assert seen[0].url.raw_path == b"/axon/litellm-admin" + path.encode("ascii")
            assert "authorization" not in seen[0].headers
            assert "cookie" not in seen[0].headers
            auth.assert_not_awaited()
            identity.authenticated_key.assert_not_awaited()
        finally:
            await transport.aclose()

    asyncio.run(run())


def test_browser_credentials_forwarded_without_client_defaults_or_identity_headers(settings: LiteLLMSettings) -> None:
    async def run() -> None:
        seen: list[httpx.Request] = []

        async def upstream(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return httpx.Response(200, headers={"set-cookie": "token=other-browser; Path=/"})

        # Even injected clients with auth/cookies/default headers cannot grant
        # their credentials to visitors or replay another visitor's session.
        pool = httpx.AsyncClient(
            transport=httpx.MockTransport(upstream),
            auth=("backend-user", "backend-password"),
            cookies={"token": "shared-client-cookie"},
            headers={"x-api-key": "client-default-key"},
        )
        transport = LiteLLMTransport(settings, client=pool)
        app = FastAPI()
        app.state.litellm_transport = transport
        mount_litellm_ui_proxy(app)
        try:
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="https://public.test"
            ) as client:
                response = await client.get(
                    "/litellm-admin/key/info?key=browser-owned-key",
                    headers={
                        "authorization": "Bearer browser-owned-key",
                        "cookie": "token=browser-token; oauth_state=state; encrypted_session_data=axon-secret",
                        "x-auth-context": "spoofed",
                        "x-encrypted-session-data": "axon-secret",
                        "x-litellm-end-user-id": "spoofed",
                        "x-litellm-spend-logs-metadata": "spoofed",
                        "x-user-id": "spoofed",
                        "x-team-id": "spoofed",
                        "x-session-refresh-token": "axon-secret",
                        "forwarded": "host=evil.test;proto=http",
                        "x-forwarded-host": "evil.test",
                        "x-forwarded-proto": "http",
                        "x-forwarded-prefix": "/evil",
                        "connection": "x-remove",
                        "x-remove": "hop-by-hop",
                    },
                )
                assert response.status_code == 200
            # A different browser has neither a login cookie nor authorization.
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="https://public.test"
            ) as visitor:
                await visitor.get("/litellm-admin/v1/models")
            first, second = seen
            assert first.headers["authorization"] == "Bearer browser-owned-key"
            assert first.headers["cookie"] == "token=browser-token; oauth_state=state"
            assert first.url.query == b"key=browser-owned-key"
            assert first.headers["x-forwarded-host"] == "public.test"
            assert first.headers["x-forwarded-proto"] == "https"
            assert first.headers["x-request-id"] == response.headers["x-request-id"]
            assert {
                "x-auth-context",
                "x-encrypted-session-data",
                "x-litellm-end-user-id",
                "x-litellm-spend-logs-metadata",
                "x-user-id",
                "x-team-id",
                "x-session-refresh-token",
                "forwarded",
                "x-forwarded-prefix",
                "x-remove",
            }.isdisjoint(first.headers)
            assert {"authorization", "cookie", "x-api-key"}.isdisjoint(second.headers)
            assert all(settings.api_key not in repr(request.headers.raw) for request in seen)
        finally:
            await transport.aclose()

    asyncio.run(run())


@pytest.mark.parametrize("status", [200, 302, 401, 403])
def test_native_login_responses_preserve_cookies_status_and_auth_challenge(
    settings: LiteLLMSettings, status: int
) -> None:
    async def run() -> None:
        cookies = [
            "token=native-token; Path=/axon/litellm-admin; Secure; SameSite=Lax",
            "oauth_state=state; Path=/axon/litellm-admin; Secure; HttpOnly; SameSite=Lax",
        ]

        def upstream(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                status,
                content=b"native-login-response",
                headers=[
                    *(("set-cookie", cookie) for cookie in cookies),
                    ("www-authenticate", "Bearer"),
                    ("location", "http://litellm.test:4000/axon/litellm-admin/ui/?login=ok"),
                    ("x-session-refresh-token", "not-an-axon-refresh"),
                    ("connection", "x-remove"),
                    ("x-remove", "hop-by-hop"),
                ],
            )

        pool = httpx.AsyncClient(transport=httpx.MockTransport(upstream), follow_redirects=True)
        transport = LiteLLMTransport(settings, client=pool)
        app = FastAPI()
        app.state.litellm_transport = transport
        mount_litellm_ui_proxy(app)
        try:
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="https://public.test"
            ) as client:
                response = await client.post("/litellm-admin/login", content=b"username=user&password=password")
            assert response.status_code == status
            assert response.content == b"native-login-response"
            assert response.headers.get_list("set-cookie") == cookies
            assert response.headers["www-authenticate"] == "Bearer"
            assert response.headers["location"] == "/axon/litellm-admin/ui/?login=ok"
            assert {"x-session-refresh-token", "x-remove", "connection"}.isdisjoint(response.headers)
        finally:
            await transport.aclose()

    asyncio.run(run())


@pytest.mark.parametrize(
    "location, expected",
    [
        ("/ui/?login=ok", "/axon/litellm-admin/ui/?login=ok"),
        ("http://litellm.test:4000/ui/", "/axon/litellm-admin/ui/"),
        ("https://sso.test/authorize?state=abc", "https://sso.test/authorize?state=abc"),
        ("https://deputydev.ai/axon/litellm-admin/ui/", "https://deputydev.ai/axon/litellm-admin/ui/"),
        ("ui/", "ui/"),
    ],
)
def test_login_redirects_stay_public_without_rewriting_external_sso(
    settings: LiteLLMSettings, location: str, expected: str
) -> None:
    async def run() -> None:
        def upstream(request: httpx.Request) -> httpx.Response:
            return httpx.Response(302, headers={"location": location})

        transport = LiteLLMTransport(settings, client=httpx.AsyncClient(transport=httpx.MockTransport(upstream)))
        app = FastAPI()
        app.state.litellm_transport = transport
        mount_litellm_ui_proxy(app)
        try:
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="https://public.test"
            ) as client:
                response = await client.get("/litellm-admin/login")
            assert response.status_code == 302
            assert response.headers["location"] == expected
        finally:
            await transport.aclose()

    asyncio.run(run())


@pytest.mark.parametrize("path", ["/litellm-admin", "/litellm-admin/"])
def test_browser_mount_root_redirects_to_public_ui(settings: LiteLLMSettings, path: str) -> None:
    async def run() -> None:
        transport = LiteLLMTransport(settings)
        app = FastAPI()
        app.state.litellm_transport = transport
        mount_litellm_ui_proxy(app)
        try:
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="https://public.test"
            ) as client:
                response = await client.get(path)
            assert response.status_code == 307
            assert response.headers["location"] == "/axon/litellm-admin/ui/"
        finally:
            await transport.aclose()

    asyncio.run(run())


def browser_scope(app: FastAPI, raw_path: bytes = b"/login") -> Scope:
    return {
        "type": "http",
        "method": "POST",
        "scheme": "https",
        "http_version": "1.1",
        "path": "/axon/litellm-admin" + unquote(raw_path.decode("ascii")),
        "raw_path": b"/axon/litellm-admin" + raw_path,
        "root_path": "/axon/litellm-admin",
        "query_string": b"",
        "headers": [],
        "app": app,
    }


@pytest.mark.parametrize("raw_path", [b"/../secret", b"/%2e%2e/secret", b"/%252e%252e%252fsecret"])
def test_browser_rejects_traversal_before_reading_body(raw_path: bytes) -> None:
    async def run() -> None:
        app = FastAPI()
        transport = AsyncMock(spec=LiteLLMTransport)
        app.state.litellm_transport = transport
        receive = AsyncMock()
        messages: list[Message] = []

        async def send(message: Message) -> None:
            messages.append(message)

        await LiteLLMUIProxy()(browser_scope(app, raw_path), receive, send)
        assert messages[0]["status"] == 400
        transport.send_stream.assert_not_awaited()
        receive.assert_not_awaited()

    asyncio.run(run())


@pytest.mark.parametrize("failure", ["not-ready", "transport"])
def test_browser_errors_are_sanitized(settings: LiteLLMSettings, failure: str) -> None:
    async def run() -> None:
        app = FastAPI()
        if failure == "transport":
            transport = AsyncMock(spec=LiteLLMTransport)
            transport.send_stream.side_effect = httpx.ConnectError("secret upstream credential")
            transport.settings = settings
            app.state.litellm_transport = transport
        messages: list[Message] = []

        async def send(message: Message) -> None:
            messages.append(message)

        receive = AsyncMock(return_value={"type": "http.request", "body": b""})
        await LiteLLMUIProxy()(browser_scope(app), receive, send)
        assert messages[0]["status"] == (503 if failure == "not-ready" else 502)
        assert b"secret" not in messages[1]["body"]

    asyncio.run(run())


class BrowserStream(httpx.AsyncByteStream):
    closed = False
    reads = 0

    async def __aiter__(self) -> AsyncIterator[bytes]:
        for chunk in (b"raw-", b"compressed-bytes"):
            self.reads += 1
            yield chunk

    async def aclose(self) -> None:
        self.closed = True


@pytest.mark.parametrize("cancel", [False, True])
def test_browser_streams_raw_body_and_closes_on_cancellation(settings: LiteLLMSettings, cancel: bool) -> None:
    async def run() -> None:
        body_chunks: list[bytes] = []
        request_chunks = iter(
            [
                {"type": "http.request", "body": b"username=user&", "more_body": True},
                {"type": "http.request", "body": b"password=password", "more_body": False},
            ]
        )

        stream = BrowserStream()

        class StreamingTransport(httpx.AsyncBaseTransport):
            async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
                async for chunk in request.stream:
                    body_chunks.append(chunk)
                return httpx.Response(200, stream=stream, headers={"content-encoding": "gzip"})

        transport = LiteLLMTransport(settings, client=httpx.AsyncClient(transport=StreamingTransport()))
        app = FastAPI()
        app.state.litellm_transport = transport
        messages: list[Message] = []

        async def receive() -> Message:
            assert len(body_chunks) == (0 if not body_chunks else 1)
            return next(request_chunks)

        async def send(message: Message) -> None:
            messages.append(message)
            assert stream.reads == sum(bool(item.get("body")) for item in messages)
            if cancel and message.get("body"):
                raise asyncio.CancelledError

        try:
            if cancel:
                with pytest.raises(asyncio.CancelledError):
                    await LiteLLMUIProxy()(browser_scope(app), receive, send)
            else:
                await LiteLLMUIProxy()(browser_scope(app), receive, send)
                assert [message["body"] for message in messages[1:-1]] == [b"raw-", b"compressed-bytes"]
            assert stream.closed
            assert body_chunks == [b"username=user&", b"password=password"]
        finally:
            await transport.aclose()

    asyncio.run(run())
