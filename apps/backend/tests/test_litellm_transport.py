"""LiteLLM transport owns fixed-origin URLs, management I/O, and pool lifetime."""

import asyncio
from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest

from app.clients.litellm.transport import LiteLLMTransport
from app.core.config import LiteLLMSettings


@pytest.fixture
def settings() -> LiteLLMSettings:
    return LiteLLMSettings(
        upstream_url="http://litellm.test",
        upstream_root_path="/private",
        connect_timeout_seconds=10,
        pool_timeout_seconds=10,
        max_connections=10,
        max_keepalive_connections=5,
        keepalive_expiry_seconds=5,
        api_key="admin-key",
    )


def test_fixed_origin_preserves_raw_path_and_query(settings: LiteLLMSettings) -> None:
    async def run() -> None:
        transport = LiteLLMTransport(settings)
        try:
            url = transport.upstream_url(b"/files/a%2Fb", b"q=a%2Bb&q=c&blank=")
            assert str(url) == "http://litellm.test/private/files/a%2Fb?q=a%2Bb&q=c&blank="
            assert transport.upstream_url(b"//evil.test/path").host == "litellm.test"
            assert str(transport.upstream_url(b"/")) == "http://litellm.test/private/"
        finally:
            await transport.aclose()

    asyncio.run(run())


@pytest.mark.parametrize(
    "raw_path",
    [
        b"/.",
        b"/..",
        b"/../../other/x",
        b"../other/x",
        b"/v1/./models",
        b"/v1/../models",
        b"/v1/%2e/models",
        b"/%2e%2e/%2E%2E/other/x",
        b"/.%2e/%2e./other/x",
        b"/%2e%2e%2f%2e%2e%2fother/x",
        b"/v1%2F..%2Fmodels",
        b"/%252e%252e/other/x",
        b"/%252e%252e%252fother/x",
        b"/%25252e%25252e/other/x",
    ],
)
def test_fixed_origin_rejects_dot_segments(settings: LiteLLMSettings, raw_path: bytes) -> None:
    async def run() -> None:
        transport = LiteLLMTransport(settings)
        try:
            with pytest.raises(ValueError, match="dot segments"):
                transport.upstream_url(raw_path)
        finally:
            await transport.aclose()

    asyncio.run(run())


@pytest.mark.parametrize("raw_path", [b"/files/.hidden", b"/files/a..b", b"/files/a%2Eb", b"/files/a%252Fb"])
def test_fixed_origin_preserves_safe_dots_and_encoding(settings: LiteLLMSettings, raw_path: bytes) -> None:
    async def run() -> None:
        transport = LiteLLMTransport(settings)
        try:
            query = b"path=/../../other/x&q=%2e%2e"
            url = transport.upstream_url(raw_path, query)
            assert url.raw_path == b"/private" + raw_path + b"?" + query
        finally:
            await transport.aclose()

    asyncio.run(run())


def test_management_uses_fixed_root_credentials_and_timeout(settings: LiteLLMSettings) -> None:
    seen: list[httpx.Request] = []

    def upstream(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"user_info": None})

    async def run() -> None:
        client = httpx.AsyncClient(transport=httpx.MockTransport(upstream))
        transport = LiteLLMTransport(settings, management_client=client)
        try:
            response = await transport.request(
                "GET", "/user/info", api_key="admin-key", timeout_seconds=3, params={"user_id": "12"}
            )
            assert response.json() == {"user_info": None}
        finally:
            await transport.aclose()
        assert client.is_closed

    asyncio.run(run())
    assert str(seen[0].url) == "http://litellm.test/private/user/info?user_id=12"
    assert seen[0].headers["authorization"] == "Bearer admin-key"
    assert seen[0].extensions["timeout"]["read"] == 3


def test_streaming_redirects_are_not_followed(settings: LiteLLMSettings) -> None:
    seen: list[httpx.Request] = []

    def upstream(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(302, headers={"location": "http://evil.test"})

    async def body() -> AsyncIterator[bytes]:
        yield b"request body"

    async def run() -> None:
        # Even an injected client with permissive defaults must not follow redirects.
        client = httpx.AsyncClient(transport=httpx.MockTransport(upstream), follow_redirects=True)
        transport = LiteLLMTransport(settings, client=client)
        try:
            response = await transport.send_stream(
                "POST", b"/v1/chat/completions", headers=[(b"authorization", b"Bearer native-key")], content=body()
            )
            assert response.status_code == 302
            await response.aclose()
        finally:
            await transport.aclose()

    asyncio.run(run())
    assert len(seen) == 1
    assert seen[0].url.host == "litellm.test"
    # Settings apply even when the injected streaming client has different defaults.
    assert seen[0].extensions["timeout"] == {
        "connect": settings.connect_timeout_seconds,
        "read": settings.read_timeout_seconds,
        "write": None,
        "pool": settings.pool_timeout_seconds,
    }


def test_shared_streaming_pool_does_not_store_browser_cookies(
    settings: LiteLLMSettings, monkeypatch: pytest.MonkeyPatch
) -> None:
    seen: list[httpx.Request] = []
    original_client = httpx.AsyncClient

    def upstream(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, headers={"set-cookie": "token=browser-secret; Path=/; HttpOnly"})

    def client_factory(**kwargs: Any) -> httpx.AsyncClient:
        return original_client(transport=httpx.MockTransport(upstream), **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", client_factory)

    async def run() -> None:
        transport = LiteLLMTransport(settings)
        try:
            first = await transport.send_stream("POST", b"/login", headers=[])
            assert first.headers["set-cookie"] == "token=browser-secret; Path=/; HttpOnly"
            assert not transport._client.cookies
            await first.aclose()
            second = await transport.send_stream("GET", b"/v1/models", headers=[])
            await second.aclose()
            assert not transport._client.cookies
        finally:
            await transport.aclose()

    asyncio.run(run())
    assert all("cookie" not in request.headers for request in seen)
