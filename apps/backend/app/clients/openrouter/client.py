"""Async OpenRouter client for chat completions and typed decisions."""

import ssl
from collections.abc import AsyncIterator, Mapping
from typing import Any

import httpx

from app.clients.openrouter.exceptions import (
    OpenRouterAPIError,
    OpenRouterResponseError,
    OpenRouterTransportError,
)
from app.core.config import OpenRouterSettings

CHAT_COMPLETIONS_PATH = "v1/chat/completions"
DECISIONS_PATH = "alpha/decisions"


def _verify_ssl_context(certificate_bundle: str) -> ssl.SSLContext | bool:
    """Use only the CA bundle explicitly configured in backend config.json."""
    if not certificate_bundle:
        return True
    return ssl.create_default_context(cafile=certificate_bundle)


class OpenRouterClient:
    """Share one connection pool across backend OpenRouter integrations."""

    def __init__(self, settings: OpenRouterSettings) -> None:
        headers = {
            "Authorization": f"Bearer {settings.api_key}",
            "Accept": "application/json",
            "Content-Type": "application/json",
            "HTTP-Referer": settings.http_referer,
            "X-OpenRouter-Title": settings.app_title,
        }
        if settings.app_categories:
            headers["X-OpenRouter-Categories"] = settings.app_categories

        self._client = httpx.AsyncClient(
            base_url=settings.base_url,
            headers=headers,
            timeout=httpx.Timeout(
                timeout=settings.request_timeout_seconds,
                connect=settings.connect_timeout_seconds,
                pool=settings.pool_timeout_seconds,
            ),
            limits=httpx.Limits(
                max_connections=settings.max_connections,
                max_keepalive_connections=settings.max_keepalive_connections,
                keepalive_expiry=settings.keepalive_expiry_seconds,
            ),
            follow_redirects=False,
            trust_env=False,
            verify=_verify_ssl_context(settings.ca_bundle),
        )

    async def create_chat_completion(
        self,
        request: Mapping[str, Any],
    ) -> dict[str, Any]:
        """Create a non-streaming chat completion and preserve its raw message fields."""
        if request.get("stream") is True:
            raise ValueError("Use stream_chat_completion() for streaming requests")
        return await self._post_json(CHAT_COMPLETIONS_PATH, request)

    async def stream_chat_completion(
        self,
        request: Mapping[str, Any],
    ) -> AsyncIterator[dict[str, Any]]:
        """Yield decoded OpenRouter SSE events, including reasoning detail deltas."""
        payload = dict(request)
        payload["stream"] = True

        try:
            async with self._client.stream(
                "POST",
                CHAT_COMPLETIONS_PATH,
                json=payload,
            ) as response:
                await self._raise_for_status(response)
                async for event_data in self._iter_sse_data(response):
                    if event_data == "[DONE]":
                        return
                    yield self._decode_json_object(event_data)
        except OpenRouterAPIError:
            raise
        except httpx.HTTPError as exc:
            raise OpenRouterTransportError(f"OpenRouter streaming request failed: {exc}") from exc

    async def create_decision(
        self,
        request: Mapping[str, Any],
    ) -> dict[str, Any]:
        """Answer typed questions through OpenRouter's non-streaming decisions API."""
        if request.get("stream") is True:
            raise ValueError("The OpenRouter decisions API does not support streaming")
        return await self._post_json(DECISIONS_PATH, request)

    async def close(self) -> None:
        """Close the underlying HTTP connection pool."""
        await self._client.aclose()

    async def _post_json(
        self,
        path: str,
        request: Mapping[str, Any],
    ) -> dict[str, Any]:
        try:
            response = await self._client.post(path, json=dict(request))
        except httpx.HTTPError as exc:
            raise OpenRouterTransportError(f"OpenRouter request failed: {exc}") from exc

        await self._raise_for_status(response)
        return self._decode_json_object(response.text)

    @staticmethod
    async def _raise_for_status(response: httpx.Response) -> None:
        if response.is_success:
            return

        await response.aread()
        message = "Request failed"
        try:
            payload = response.json()
            if isinstance(payload, dict):
                error = payload.get("error")
                if isinstance(error, dict) and isinstance(error.get("message"), str):
                    message = error["message"]
                elif isinstance(error, str):
                    message = error
                elif isinstance(payload.get("message"), str):
                    message = payload["message"]
        except ValueError:
            pass

        raise OpenRouterAPIError(
            response.status_code,
            message,
            request_id=response.headers.get("x-request-id"),
        )

    @staticmethod
    async def _iter_sse_data(response: httpx.Response) -> AsyncIterator[str]:
        data_lines: list[str] = []
        async for line in response.aiter_lines():
            if line == "":
                if data_lines:
                    yield "\n".join(data_lines)
                    data_lines.clear()
                continue
            if line.startswith(":"):
                continue
            if line.startswith("data:"):
                data_lines.append(line.removeprefix("data:").lstrip())

        if data_lines:
            yield "\n".join(data_lines)

    @staticmethod
    def _decode_json_object(raw: str) -> dict[str, Any]:
        try:
            payload = httpx.Response(200, text=raw).json()
        except ValueError as exc:
            raise OpenRouterResponseError("OpenRouter returned invalid JSON") from exc
        if not isinstance(payload, dict):
            raise OpenRouterResponseError("OpenRouter returned a non-object JSON response")
        return payload
