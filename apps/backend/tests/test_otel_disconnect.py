"""Interrupted telemetry uploads are cancellations, not server exceptions."""

import asyncio
import logging

import httpx
import pytest
from starlette.types import Message

from tests.test_otel_proxy import payload, setup


@pytest.mark.parametrize("signal", ["traces", "metrics", "logs"])
@pytest.mark.parametrize("partial", [False, True])
def test_disconnected_upload_is_not_forwarded_and_releases_capacity(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture, signal: str, partial: bool
) -> None:
    caplog.set_level(logging.INFO, logger="app.proxies.otel")

    async def run() -> None:
        app, upstream, seen, _ = setup(monkeypatch, max_concurrent_requests=1)
        runtime = app.state.otel_proxy
        body = payload(signal).SerializeToString()
        messages: list[Message] = []
        frames = []
        if partial:
            frames.append({"type": "http.request", "body": body[: max(1, len(body) // 2)], "more_body": True})
        frames.append({"type": "http.disconnect"})
        incoming = iter(frames)
        scope = {
            "type": "http",
            "http_version": "1.1",
            "method": "POST",
            "scheme": "http",
            "path": f"/api/v1/otel/v1/{signal}",
            "query_string": b"",
            "root_path": "",
            "headers": [(b"authorization", b"Bearer session-secret"), (b"content-type", b"application/x-protobuf")],
            "server": ("backend.test", 80),
            "client": ("127.0.0.1", 1234),
        }

        async def receive() -> Message:
            return next(incoming)

        async def send(message: Message) -> None:
            messages.append(message)

        async with upstream:
            await app(scope, receive, send)
            assert messages[0]["status"] == 499
            headers = httpx.Headers(messages[0]["headers"])
            assert headers["cache-control"] == "no-store"
            assert headers["x-session-refresh-token"] == "rotated-secret"
            assert not seen
            assert runtime.active == 0
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://backend.test"
            ) as client:
                result = await client.post(
                    f"/api/v1/otel/v1/{signal}",
                    content=body,
                    headers={"Authorization": "Bearer session-secret", "Content-Type": "application/x-protobuf"},
                )
            assert result.status_code == 200
            assert len(seen) == 1
            assert runtime.active == 0

    asyncio.run(run())
    records = [record for record in caplog.records if record.name == "app.proxies.otel"]
    assert len(records) == 1
    record = records[0]
    assert record.levelno == logging.INFO
    assert record.getMessage() == f"Telemetry upload cancelled signal={signal} reason=client_disconnected"
    assert record.exc_info is None
    assert "secret" not in record.getMessage()
