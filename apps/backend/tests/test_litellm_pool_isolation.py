"""Exercise LiteLLM pool isolation and idle timeouts over real HTTP connections."""

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from dataclasses import replace
from unittest.mock import AsyncMock

import httpx
import pytest

from app.clients.litellm.transport import LiteLLMTransport
from app.core.config import LiteLLMSettings
from app.proxies.litellm_common import ResponseHead, UpstreamRequest, forward_stream


@asynccontextmanager
async def upstream_server(
    handler: Callable[[asyncio.StreamReader, asyncio.StreamWriter], Awaitable[None]],
) -> AsyncIterator[str]:
    tasks: list[asyncio.Task[None]] = []

    async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            await handler(reader, writer)
        finally:
            writer.close()
            await writer.wait_closed()

    def connected(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        tasks.append(asyncio.create_task(handle(reader, writer)))

    server = await asyncio.start_server(connected, "127.0.0.1", 0)
    try:
        yield f"http://127.0.0.1:{server.sockets[0].getsockname()[1]}"
    finally:
        server.close()
        await server.wait_closed()
        for task in tasks:
            if not task.done():
                task.cancel()
        results = await asyncio.gather(*tasks, return_exceptions=True)
        for result in results:
            if isinstance(result, BaseException) and not isinstance(result, asyncio.CancelledError):
                raise result


def settings(origin: str) -> LiteLLMSettings:
    return LiteLLMSettings(
        upstream_url=origin,
        upstream_root_path="/",
        connect_timeout_seconds=1,
        pool_timeout_seconds=1,
        read_timeout_seconds=1,
        max_connections=1,
        max_keepalive_connections=1,
        management_max_connections=1,
        keepalive_expiry_seconds=5,
    )


@pytest.mark.parametrize("stall_at", ["headers", "body"])
def test_stalled_stream_does_not_block_management_and_releases_connection(stall_at: str) -> None:
    async def run() -> None:
        stalled = asyncio.Event()
        responses: list[httpx.Response] = []

        async def handler(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
            request = await reader.readuntil(b"\r\n\r\n")
            if request.startswith(b"GET /stall "):
                if stall_at == "body":
                    writer.write(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\na\r\n")
                    await writer.drain()
                stalled.set()
                await reader.read()  # Upstream never sends headers/the next body chunk.
            else:
                writer.write(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}")
                await writer.drain()

        async with upstream_server(handler) as origin:
            transport = LiteLLMTransport(settings(origin))

            async def consume_stalled_stream() -> None:
                response = await transport.send_stream("GET", b"/stall", headers=[])
                responses.append(response)
                try:
                    await response.aread()
                finally:
                    await response.aclose()

            pending = asyncio.create_task(consume_stalled_stream())
            try:
                await asyncio.wait_for(stalled.wait(), timeout=2)
                # The sole streaming connection is occupied, but buffered calls have
                # their own pool and finish before the stalled stream's read timeout.
                response = await asyncio.wait_for(
                    transport.request("GET", "/user/info", api_key="admin-key", timeout_seconds=1),
                    timeout=0.5,
                )
                assert response.json() == {}
                assert not pending.done()
                with pytest.raises(httpx.ReadTimeout):
                    await asyncio.wait_for(pending, timeout=2)
                if stall_at == "body":
                    assert responses[0].is_closed

                # Timeout cleanup frees the only streaming slot for another call.
                response = await transport.send_stream("GET", b"/ok", headers=[])
                try:
                    assert await response.aread() == b"{}"
                finally:
                    await response.aclose()
            finally:
                pending.cancel()
                await asyncio.gather(pending, return_exceptions=True)
                await transport.aclose()
                assert transport._client.is_closed
                assert transport._management_client.is_closed

    asyncio.run(run())


def test_active_stream_can_outlive_idle_read_timeout() -> None:
    async def run() -> None:
        async def handler(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
            await reader.readuntil(b"\r\n\r\n")
            writer.write(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\na\r\n")
            await writer.drain()
            # Total duration exceeds one second, but each read stays within it.
            for _ in range(2):
                await asyncio.sleep(0.6)
                writer.write(b"1\r\na\r\n")
                await writer.drain()
            writer.write(b"0\r\n\r\n")
            await writer.drain()

        async with upstream_server(handler) as origin:
            transport = LiteLLMTransport(settings(origin))
            try:
                response = await transport.send_stream("GET", b"/active", headers=[])
                try:
                    assert await asyncio.wait_for(response.aread(), timeout=3) == b"aaa"
                finally:
                    await response.aclose()
            finally:
                await transport.aclose()

    asyncio.run(run())


def test_management_and_streaming_clients_are_routed_and_closed_independently() -> None:
    async def run() -> None:
        seen: list[str] = []

        def streaming(request: httpx.Request) -> httpx.Response:
            seen.append("streaming")
            return httpx.Response(200, content=b"stream")

        def management(request: httpx.Request) -> httpx.Response:
            seen.append("management")
            return httpx.Response(200, json={})

        stream_client = httpx.AsyncClient(transport=httpx.MockTransport(streaming))
        management_client = httpx.AsyncClient(transport=httpx.MockTransport(management))
        transport = LiteLLMTransport(
            replace(settings("http://litellm.test"), read_timeout_seconds=7),
            client=stream_client,
            management_client=management_client,
        )
        try:
            await transport.request("GET", "/user/info", api_key="admin", timeout_seconds=2)
            response = await transport.send_stream("GET", b"/v1/chat/completions", headers=[])
            await response.aclose()
            assert response.request.extensions["timeout"]["read"] == 7
            assert seen == ["management", "streaming"]
        finally:
            await transport.aclose()
        assert stream_client.is_closed
        assert management_client.is_closed

    asyncio.run(run())


def test_mid_stream_read_timeout_closes_response_without_second_headers() -> None:
    class StalledStream(httpx.AsyncByteStream):
        closed = False

        async def __aiter__(self) -> AsyncIterator[bytes]:
            yield b"first chunk"
            raise httpx.ReadTimeout("upstream stalled")

        async def aclose(self) -> None:
            self.closed = True

    async def run() -> None:
        stream = StalledStream()
        response = httpx.Response(200, stream=stream)
        messages = []

        async def send(message: dict) -> None:
            messages.append(message)

        transport = AsyncMock(spec=LiteLLMTransport)
        transport.send_stream.return_value = response

        async def receive() -> dict:
            return {"type": "http.request", "body": b""}

        async def build_request(request_id: str) -> UpstreamRequest:
            return UpstreamRequest([], b"")

        with pytest.raises(httpx.ReadTimeout):
            await forward_stream(
                {"type": "http", "headers": []},
                receive,
                send,
                transport,
                b"/stream",
                build_request=build_request,
                response_policy=lambda response, request_id: ResponseHead(response.status_code, []),
            )
        assert stream.closed
        assert response.is_closed
        assert [message["status"] for message in messages if message["type"] == "http.response.start"] == [200]
        assert not any(message.get("more_body") is False for message in messages)

    asyncio.run(run())
