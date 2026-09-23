"""Transparent HTTP proxy for the privately hosted LiteLLM service."""

import logging
from collections.abc import AsyncIterator, Iterable
from urllib.parse import quote

import httpx
from fastapi import FastAPI
from starlette.types import Message, Receive, Scope, Send

from app.core.config import LiteLLMSettings, get_settings

LITELLM_MOUNT_PATH = "/litellm"
LITELLM_CLIENT_STATE_KEY = "litellm_proxy_client"

# These headers describe one transport connection and must not cross the
# downstream-to-upstream proxy boundary.
_HOP_BY_HOP_HEADERS = {
    b"connection",
    b"keep-alive",
    b"proxy-authenticate",
    b"proxy-authorization",
    b"te",
    b"trailer",
    b"transfer-encoding",
    b"upgrade",
}
_BAD_GATEWAY_BODY = b'{"detail":"LiteLLM upstream is unavailable"}'
_SERVICE_UNAVAILABLE_BODY = b'{"detail":"LiteLLM proxy is not ready"}'
logger = logging.getLogger(__name__)


def _connection_tokens(headers: Iterable[tuple[bytes, bytes]]) -> set[bytes]:
    """Return additional hop-by-hop header names declared by Connection."""
    tokens: set[bytes] = set()
    for name, value in headers:
        if name.lower() != b"connection":
            continue
        tokens.update(token.strip().lower() for token in value.split(b",") if token.strip())
    return tokens


def _end_to_end_headers(
    headers: Iterable[tuple[bytes, bytes]],
) -> list[tuple[bytes, bytes]]:
    """Preserve header order and duplicates while removing hop-by-hop fields."""
    raw_headers = list(headers)
    excluded_headers = _HOP_BY_HOP_HEADERS | _connection_tokens(raw_headers)
    return [(name, value) for name, value in raw_headers if name.lower() not in excluded_headers]


def _relative_raw_path(scope: Scope, *, strip_mount_path: bool) -> bytes:
    """Return the encoded request path after Starlette's mounted root path."""
    raw_path = scope.get("raw_path")
    if not isinstance(raw_path, bytes):
        raw_path = quote(str(scope.get("path", "/")), safe="/").encode("ascii")

    root_path = str(scope.get("root_path", ""))
    encoded_root_path = quote(root_path, safe="/").encode("ascii")
    if encoded_root_path and raw_path.startswith(encoded_root_path):
        relative_path = raw_path[len(encoded_root_path) :]
    else:
        decoded_path = str(scope.get("path", "/"))
        if root_path and decoded_path.startswith(root_path):
            decoded_path = decoded_path[len(root_path) :]
        relative_path = quote(decoded_path, safe="/").encode("ascii")

    if strip_mount_path:
        encoded_mount_path = LITELLM_MOUNT_PATH.encode("ascii")
        if relative_path == encoded_mount_path:
            relative_path = b"/"
        elif relative_path.startswith(encoded_mount_path + b"/"):
            relative_path = relative_path[len(encoded_mount_path) :]

    if not relative_path:
        return b"/"
    if not relative_path.startswith(b"/"):
        return b"/" + relative_path
    return relative_path


def _upstream_url(
    scope: Scope,
    settings: LiteLLMSettings,
    *,
    strip_mount_path: bool,
) -> httpx.URL:
    """Build the fixed-origin upstream URL while preserving path encoding and query order."""
    relative_path = _relative_raw_path(scope, strip_mount_path=strip_mount_path)
    upstream_root_path = settings.upstream_root_path.encode("ascii")

    if upstream_root_path == b"/":
        raw_path = relative_path
    elif relative_path == b"/":
        raw_path = upstream_root_path + b"/"
    else:
        raw_path = upstream_root_path + relative_path

    query_string = scope.get("query_string", b"")
    if isinstance(query_string, bytes) and query_string:
        raw_path += b"?" + query_string

    return httpx.URL(settings.upstream_url).copy_with(raw_path=raw_path)


async def _request_body(
    first_message: Message,
    receive: Receive,
) -> AsyncIterator[bytes]:
    """Stream the downstream request body without buffering it in memory."""
    message = first_message
    while message["type"] == "http.request":
        body = message.get("body", b"")
        if body:
            yield body
        if not message.get("more_body", False):
            return
        message = await receive()


async def _send_error(send: Send, status_code: int, body: bytes) -> None:
    await send(
        {
            "type": "http.response.start",
            "status": status_code,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode("ascii")),
            ],
        }
    )
    await send({"type": "http.response.body", "body": body})


async def _send_upstream_response(
    upstream_response: httpx.Response,
    send: Send,
) -> None:
    """Stream an upstream response and always release its pooled connection."""
    try:
        await send(
            {
                "type": "http.response.start",
                "status": upstream_response.status_code,
                "headers": _end_to_end_headers(upstream_response.headers.raw),
            }
        )
        if upstream_response.is_stream_consumed:
            if upstream_response.content:
                await send(
                    {
                        "type": "http.response.body",
                        "body": upstream_response.content,
                        "more_body": True,
                    }
                )
        else:
            async for chunk in upstream_response.aiter_raw():
                if chunk:
                    await send(
                        {
                            "type": "http.response.body",
                            "body": chunk,
                            "more_body": True,
                        }
                    )
        await send(
            {
                "type": "http.response.body",
                "body": b"",
                "more_body": False,
            }
        )
    except OSError:
        # Closing the response releases the upstream connection when the
        # downstream client disconnects during a streamed completion.
        return
    finally:
        await upstream_response.aclose()


class LiteLLMProxy:
    """Forward arbitrary HTTP traffic to LiteLLM without response buffering."""

    def __init__(
        self,
        settings: LiteLLMSettings,
        *,
        strip_mount_path: bool = False,
    ) -> None:
        self.settings = settings
        self.strip_mount_path = strip_mount_path

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            if scope["type"] == "websocket":
                await send({"type": "websocket.close", "code": 1008})
            return

        app = scope.get("app")
        app_state = getattr(app, "state", None)
        client: httpx.AsyncClient | None = getattr(
            app_state,
            LITELLM_CLIENT_STATE_KEY,
            None,
        )
        if client is None:
            await _send_error(send, 503, _SERVICE_UNAVAILABLE_BODY)
            return

        first_message = await receive()
        if first_message["type"] == "http.disconnect":
            return

        has_body = bool(first_message.get("body")) or bool(first_message.get("more_body", False))
        content = _request_body(first_message, receive) if has_body else None
        request_headers = _end_to_end_headers(scope.get("headers", []))

        try:
            upstream_request = httpx.Request(
                method=str(scope.get("method", "GET")),
                url=_upstream_url(
                    scope,
                    self.settings,
                    strip_mount_path=self.strip_mount_path,
                ),
                headers=request_headers,
                content=content,
            )
            upstream_response = await client.send(upstream_request, stream=True)
        except httpx.HTTPError:
            logger.warning("LiteLLM upstream request failed", exc_info=True)
            await _send_error(send, 502, _BAD_GATEWAY_BODY)
            return

        await _send_upstream_response(upstream_response, send)


def mount_litellm_proxy(app: FastAPI) -> None:
    """Expose LiteLLM at `/litellm` before the frontend catch-all is mounted."""
    settings = get_settings().litellm
    app.add_route(
        LITELLM_MOUNT_PATH,
        LiteLLMProxy(settings, strip_mount_path=True),
        name="litellm-proxy-root",
        include_in_schema=False,
    )
    app.mount(
        LITELLM_MOUNT_PATH,
        LiteLLMProxy(settings),
        name="litellm-proxy",
    )
    logger.info("LiteLLM proxy mounted at %s", LITELLM_MOUNT_PATH)
