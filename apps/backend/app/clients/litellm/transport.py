"""Application-owned LiteLLM HTTP pool, fixed-origin URLs, and upstream I/O."""

from collections.abc import AsyncIterator, Iterable
from typing import Any

import httpx

from app.core.config import LiteLLMSettings


class LiteLLMTransport:
    """Own one pool shared by streaming traffic and identity management.

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
        """Preserve encoded paths and duplicate/ordered queries on a fixed origin."""
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
        """Buffered management request; identity policy belongs to the identity client."""
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
