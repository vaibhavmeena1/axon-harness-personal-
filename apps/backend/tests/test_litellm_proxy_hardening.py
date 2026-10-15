"""Public proxy resource bounds and policy regressions, including real pool cleanup."""

import asyncio
import logging
from collections.abc import AsyncIterator
from dataclasses import replace
from unittest.mock import AsyncMock, Mock
from urllib.parse import unquote

import httpx
import pytest
from fastapi import FastAPI
from starlette.types import Message, Scope

from app.clients.litellm import transport as transport_module
from app.clients.litellm.transport import (
    MAX_PATH_DECODE_LAYERS,
    MAX_RAW_PATH_BYTES,
    LiteLLMTransport,
    validate_raw_path,
)
from app.core.config import LiteLLMSettings
from app.proxies.litellm_common import LiteLLMRequestLoggingMiddleware
from app.proxies.litellm_ui import LiteLLMUIProxy, mount_litellm_ui_proxy
from tests.test_litellm_pool_isolation import upstream_server


@pytest.fixture
def settings() -> LiteLLMSettings:
    return LiteLLMSettings(
        upstream_url="http://litellm.test:4000",
        upstream_root_path="/litellm-admin",
        connect_timeout_seconds=1,
        pool_timeout_seconds=1,
        max_connections=1,
        max_keepalive_connections=1,
        keepalive_expiry_seconds=5,
        api_key="backend-only-key",
        ui_body_idle_timeout_seconds=1,
        ui_write_timeout_seconds=1,
        ui_request_timeout_seconds=2,
        ui_max_request_body_bytes=32,
    )


def scope_for(app: FastAPI, raw_path: bytes = b"/login") -> Scope:
    return {
        "type": "http",
        "method": "POST",
        "scheme": "https",
        "http_version": "1.1",
        "path": "/litellm-admin" + unquote(raw_path.decode()),
        "raw_path": b"/litellm-admin" + raw_path,
        "root_path": "/litellm-admin",
        "query_string": b"",
        "headers": [],
        "app": app,
    }


@pytest.mark.parametrize("layers", [0, 1, 2, 3, 4])
def test_safe_paths_keep_up_to_four_encoding_layers(layers: int) -> None:
    path = b"/files/" + (b"%" + b"25" * (layers - 1) + b"61" if layers else b"a")
    validate_raw_path(path)


def test_excessive_path_encoding_is_rejected_in_bounded_work(monkeypatch: pytest.MonkeyPatch) -> None:
    # Count work rather than using timing-sensitive assertions about CPU usage.
    decode = Mock(side_effect=transport_module.unquote_to_bytes)
    monkeypatch.setattr(transport_module, "unquote_to_bytes", decode)
    with pytest.raises(ValueError, match="encoding layers"):
        validate_raw_path(b"/files/%" + b"25" * 2000 + b"61")
    assert decode.call_count == MAX_PATH_DECODE_LAYERS + 1


def test_raw_path_limit_precedes_decoding(monkeypatch: pytest.MonkeyPatch) -> None:
    validate_raw_path(b"/" + b"a" * (MAX_RAW_PATH_BYTES - 1))
    decode = Mock(side_effect=AssertionError("oversized paths must not be decoded"))
    monkeypatch.setattr(transport_module, "unquote_to_bytes", decode)
    with pytest.raises(ValueError, match="too long"):
        validate_raw_path(b"/" + b"a" * MAX_RAW_PATH_BYTES)
    decode.assert_not_called()


@pytest.mark.parametrize("path", [b"/" + b"a" * MAX_RAW_PATH_BYTES, b"/files/%252525252561"])
def test_public_invalid_paths_do_not_read_body_or_use_upstream(settings: LiteLLMSettings, path: bytes) -> None:
    async def run() -> None:
        app = FastAPI()
        transport = AsyncMock(spec=LiteLLMTransport)
        transport.settings = settings
        app.state.litellm_transport = transport
        receive = AsyncMock(side_effect=AssertionError("body must stay unread"))
        messages: list[Message] = []

        async def send(message: Message) -> None:
            messages.append(message)

        await LiteLLMUIProxy()(scope_for(app, path), receive, send)
        assert messages[0]["status"] == 400
        transport.send_stream.assert_not_awaited()
        receive.assert_not_awaited()

    asyncio.run(run())


class UploadTransport(httpx.AsyncBaseTransport):
    """Observe body iteration and release when the producer aborts."""

    def __init__(self, write_timeout: float) -> None:
        self.write_timeout = write_timeout
        self.started = False
        self.released = False

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.started = True
        assert request.extensions["timeout"]["write"] == self.write_timeout
        try:
            async for _chunk in request.stream:
                pass
            raise AssertionError("the bounded/incomplete upload must not finish")
        finally:
            self.released = True


@pytest.mark.parametrize("failure", ["first-frame-idle", "chunk-idle", "total-timeout", "oversized", "disconnected"])
def test_browser_body_bounds_and_disconnect_abort_upstream(settings: LiteLLMSettings, failure: str) -> None:
    async def run() -> None:
        limits = replace(settings, ui_max_request_body_bytes=8)
        if failure == "total-timeout":
            limits = replace(limits, ui_body_idle_timeout_seconds=2, ui_request_timeout_seconds=1)
        received = 0
        upload = UploadTransport(limits.ui_write_timeout_seconds)
        transport = LiteLLMTransport(limits, client=httpx.AsyncClient(transport=upload))
        app = FastAPI()
        app.state.litellm_transport = transport
        messages: list[Message] = []

        async def receive() -> Message:
            nonlocal received
            received += 1
            if failure == "first-frame-idle" or (received > 1 and failure == "chunk-idle"):
                await asyncio.Event().wait()
            if received == 1:
                return {"type": "http.request", "body": b"a", "more_body": True}
            if failure == "oversized":
                return {"type": "http.request", "body": b"12345678", "more_body": False}
            if failure == "disconnected":
                return {"type": "http.disconnect"}
            await asyncio.sleep(0.1)
            return {"type": "http.request", "body": b"", "more_body": True}

        async def send(message: Message) -> None:
            messages.append(message)

        try:
            await asyncio.wait_for(LiteLLMUIProxy()(scope_for(app), receive, send), timeout=3)
            if failure == "disconnected":
                assert messages == []
            else:
                assert messages[0]["status"] == (413 if failure == "oversized" else 408)
            assert upload.started is (failure != "first-frame-idle")
            assert upload.released is upload.started
        finally:
            await transport.aclose()

    asyncio.run(run())


@pytest.mark.parametrize("declared_length, first_body", [("33", b""), (None, b"a" * 33)])
def test_oversized_body_rejected_before_opening_upstream(
    settings: LiteLLMSettings, declared_length: str | None, first_body: bytes
) -> None:
    async def run() -> None:
        app = FastAPI()
        transport = AsyncMock(spec=LiteLLMTransport)
        transport.settings = settings
        app.state.litellm_transport = transport
        scope = scope_for(app)
        if declared_length:
            scope["headers"] = [(b"content-length", declared_length.encode())]
        receive = AsyncMock(return_value={"type": "http.request", "body": first_body, "more_body": True})
        messages: list[Message] = []

        async def send(message: Message) -> None:
            messages.append(message)

        await LiteLLMUIProxy()(scope, receive, send)
        assert messages[0]["status"] == 413
        transport.send_stream.assert_not_awaited()
        if declared_length:
            receive.assert_not_awaited()

    asyncio.run(run())


@pytest.mark.parametrize("failure", ["idle", "cancel"])
def test_stalled_browser_upload_releases_real_shared_pool(settings: LiteLLMSettings, failure: str) -> None:
    async def run() -> None:
        upload_started, upload_closed = asyncio.Event(), asyncio.Event()

        async def handler(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
            request = await reader.readuntil(b"\r\n\r\n")
            if request.startswith(b"POST "):
                upload_started.set()
                await reader.read()
                upload_closed.set()
            else:
                writer.write(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
                await writer.drain()

        async with upstream_server(handler) as origin:
            transport = LiteLLMTransport(replace(settings, upstream_url=origin))
            app = FastAPI()
            app.state.litellm_transport = transport
            messages: list[Message] = []
            received = 0

            async def receive() -> Message:
                nonlocal received
                received += 1
                if received > 1:
                    await asyncio.Event().wait()
                return {"type": "http.request", "body": b"first", "more_body": True}

            async def send(message: Message) -> None:
                messages.append(message)

            pending = asyncio.create_task(LiteLLMUIProxy()(scope_for(app), receive, send))
            try:
                await asyncio.wait_for(upload_started.wait(), timeout=1)
                if failure == "cancel":
                    pending.cancel()
                    with pytest.raises(asyncio.CancelledError):
                        await pending
                    assert messages == []
                else:
                    await asyncio.wait_for(pending, timeout=2)
                    assert messages[0]["status"] == 408
                await asyncio.wait_for(upload_closed.wait(), timeout=1)
                # Only one streaming slot exists. An API request must be able to
                # acquire it immediately after the public upload is aborted.
                response = await asyncio.wait_for(transport.send_stream("GET", b"/ok", headers=[]), timeout=1)
                try:
                    assert await response.aread() == b"ok"
                    assert response.request.extensions["timeout"]["write"] is None
                finally:
                    await response.aclose()
            finally:
                pending.cancel()
                await asyncio.gather(pending, return_exceptions=True)
                await transport.aclose()

    asyncio.run(run())


@pytest.mark.parametrize(
    "path,status,extra_headers,cacheable",
    [
        ("/ui/_next/static/chunks/abcd1234.js", 200, [], True),
        ("/ui/_next/static/css/abcd1234.css", 304, [], True),
        ("/_next/static/chunks/abcd1234.js", 200, [], True),
        ("/ui/_next/static/chunks/abcd1234.js", 200, [("set-cookie", "token=secret")], False),
        ("/ui/_next/static/chunks/abcd1234.js", 200, [("vary", "Cookie")], False),
        ("/ui/_next/static/chunks/abcd1234.js", 200, [("vary", "Authorization")], False),
        ("/ui/_next/static/chunks/abcd1234.js", 404, [], False),
        ("/ui/", 200, [], False),
        ("/login", 200, [], False),
        ("/key/info", 200, [], False),
    ],
)
def test_only_successful_session_free_static_assets_preserve_upstream_caching(
    settings: LiteLLMSettings, path: str, status: int, extra_headers: list[tuple[str, str]], cacheable: bool
) -> None:
    async def run() -> None:
        cache = "public, max-age=31536000, immutable"

        def upstream(request: httpx.Request) -> httpx.Response:
            return httpx.Response(status, headers=[("cache-control", cache), ("expires", "future"), *extra_headers])

        transport = LiteLLMTransport(settings, client=httpx.AsyncClient(transport=httpx.MockTransport(upstream)))
        app = FastAPI()
        app.state.litellm_transport = transport
        mount_litellm_ui_proxy(app)
        try:
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="https://public.test"
            ) as client:
                response = await client.get("/litellm-admin" + path)
            assert response.status_code == status
            assert response.headers["cache-control"] == (cache if cacheable else "no-store")
            assert ("expires" in response.headers) is cacheable
            assert response.headers.get_list("set-cookie") == [
                value for name, value in extra_headers if name == "set-cookie"
            ]
        finally:
            await transport.aclose()

    asyncio.run(run())


@pytest.mark.parametrize("location", [b"http://[invalid", b"//[invalid"])
def test_malformed_location_is_not_an_unhandled_policy_error(settings: LiteLLMSettings, location: bytes) -> None:
    async def run() -> None:
        response = httpx.Response(302, headers=[(b"location", location)], content=b"native-redirect")
        transport = AsyncMock(spec=LiteLLMTransport)
        transport.settings = settings
        transport.send_stream.return_value = response
        app = FastAPI()
        app.state.litellm_transport = transport
        messages: list[Message] = []

        async def send(message: Message) -> None:
            messages.append(message)

        await LiteLLMUIProxy()(scope_for(app), AsyncMock(return_value={"type": "http.request", "body": b""}), send)
        assert messages[0]["status"] == 302
        assert (b"location", location) in messages[0]["headers"]
        assert response.is_closed

    asyncio.run(run())


@pytest.mark.parametrize("external_root", ["", "/axon"])
def test_root_upstream_redirect_uses_the_actual_public_mount(settings: LiteLLMSettings, external_root: str) -> None:
    async def run() -> None:
        def upstream(request: httpx.Request) -> httpx.Response:
            assert request.url.path == "/login"
            return httpx.Response(302, headers={"location": "/ui/?login=ok#dashboard"})

        transport = LiteLLMTransport(
            replace(settings, upstream_root_path="/"), client=httpx.AsyncClient(transport=httpx.MockTransport(upstream))
        )
        app = FastAPI(root_path=external_root)
        app.state.litellm_transport = transport
        mount_litellm_ui_proxy(app)
        try:
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="https://public.test"
            ) as client:
                bare = await client.get(external_root + "/litellm-admin")
                login = await client.get(external_root + "/litellm-admin/login")
            prefix = external_root + "/litellm-admin/ui/"
            assert bare.headers["location"] == prefix
            assert login.headers["location"] == prefix + "?login=ok#dashboard"
        finally:
            await transport.aclose()

    asyncio.run(run())


def test_ui_mount_emits_startup_audit_log(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.INFO, logger="app.proxies.litellm_ui")
    app = FastAPI()
    mount_litellm_ui_proxy(app)
    assert "LiteLLM UI proxy mounted at /litellm-admin" in caplog.messages
    assert {"litellm-ui", "litellm-ui-root"}.issubset({route.name for route in app.routes})


@pytest.mark.parametrize("failure", ["cancel", "disconnect", "read-error"])
def test_shared_browser_response_cleanup_keeps_single_response_headers(settings: LiteLLMSettings, failure: str) -> None:
    class Stream(httpx.AsyncByteStream):
        closed = False

        async def __aiter__(self) -> AsyncIterator[bytes]:
            yield b"first"
            raise httpx.ReadError("private-upstream-detail")

        async def aclose(self) -> None:
            self.closed = True

    async def run() -> None:
        stream = Stream()
        response = httpx.Response(200, stream=stream)
        transport = AsyncMock(spec=LiteLLMTransport)
        transport.settings = settings
        transport.send_stream.return_value = response
        app = FastAPI()
        app.state.litellm_transport = transport
        messages: list[Message] = []

        async def send(message: Message) -> None:
            messages.append(message)
            if message.get("body"):
                if failure == "cancel":
                    raise asyncio.CancelledError
                if failure == "disconnect":
                    raise OSError("client disconnected")

        proxy = LiteLLMRequestLoggingMiddleware(LiteLLMUIProxy(), mount_path="/litellm-admin")
        receive = AsyncMock(return_value={"type": "http.request", "body": b""})
        if failure == "disconnect":
            await proxy(scope_for(app), receive, send)
        else:
            with pytest.raises(asyncio.CancelledError if failure == "cancel" else httpx.ReadError):
                await proxy(scope_for(app), receive, send)
        assert stream.closed
        assert [message["status"] for message in messages if message["type"] == "http.response.start"] == [200]
        assert not any(message.get("more_body") is False for message in messages)

    asyncio.run(run())
