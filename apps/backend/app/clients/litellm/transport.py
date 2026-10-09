"""Application-owned LiteLLM HTTP pool, fixed-origin URLs, and upstream I/O."""

from collections.abc import AsyncIterator, Iterable
from typing import Any
from urllib.parse import unquote_to_bytes

import httpx

from app.core.config import LiteLLMSettings


def validate_raw_path(raw_path: bytes) -> None:
    """Reject dot segments at every decoding layer without rewriting safe paths."""
    path = raw_path
    while True:
        if any(segment in {b".", b".."} for segment in path.split(b"/")):
            raise ValueError("LiteLLM request paths must not contain dot segments")
        # Encoded separators can expose segments, and an upstream gateway
        # may decode nested escapes more than once.
        decoded_path = unquote_to_bytes(path)
        if decoded_path == path:
            return
        path = decoded_path


class LiteLLMTransport:
    """Own one pool shared by streaming traffic, identity management and decisions.

    An injected HTTP client is also owned and closed by this wrapper. Callers of
    send_stream own the returned response and must close it, including on cancellation.
    """

    def __init__(self, settings: LiteLLMSettings, *, client: httpx.AsyncClient | None = None) -> None:
        self.settings = settings
        self._client = client
        if self._client is None:
            self._client = httpx.AsyncClient(
                timeout=httpx.Timeout(
                    connect=settings.connect_timeout_seconds,
                    read=None,
                    write=None,
                    pool=settings.pool_timeout_seconds,
                ),
                limits=httpx.Limits(
                    max_connections=settings.max_connections,
                    max_keepalive_connections=settings.max_keepalive_connections,
                    keepalive_expiry=settings.keepalive_expiry_seconds,
                ),
                follow_redirects=False,
                trust_env=False,
            )

    def upstream_url(self, raw_path: bytes, query_string: bytes = b"") -> httpx.URL:
        """Preserve safe encoded paths and duplicate/ordered queries on a fixed origin."""
        validate_raw_path(raw_path)
        root = self.settings.upstream_root_path.rstrip("/").encode("ascii")
        path = root + (raw_path if raw_path.startswith(b"/") else b"/" + raw_path)
        if query_string:
            path += b"?" + query_string
        return httpx.URL(self.settings.upstream_url).copy_with(raw_path=path)

    async def request(
        self,
        method: str,
        path: str,
        *,
        api_key: str,
        timeout_seconds: float,
        params: dict[str, str] | None = None,
        payload: dict[str, Any] | None = None,
    ) -> httpx.Response:
        """Buffered upstream request; identity and decision policy belong to their clients."""
        return await self._client.request(
            method,
            self.upstream_url(path.encode("ascii")),
            headers={"Authorization": f"Bearer {api_key}"},
            params=params,
            json=payload,
            timeout=httpx.Timeout(timeout_seconds),
            follow_redirects=False,
        )

    async def send_stream(
        self,
        method: str,
        raw_path: bytes,
        *,
        query_string: bytes = b"",
        headers: Iterable[tuple[bytes, bytes]],
        content: AsyncIterator[bytes] | None = None,
    ) -> httpx.Response:
        """Forward without buffering, default headers, redirects, or payload inspection."""
        request = httpx.Request(
            method=method,
            url=self.upstream_url(raw_path, query_string),
            headers=headers,
            content=content,
        )
        return await self._client.send(request, stream=True, follow_redirects=False)

    async def aclose(self) -> None:
        await self._client.aclose()
