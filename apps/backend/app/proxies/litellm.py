"""Authenticated HTTP proxy for the privately hosted LiteLLM service."""

import logging
import re
from collections.abc import AsyncIterator, Iterable
from urllib.parse import quote
from uuid import uuid4

import httpx
from fastapi import FastAPI, Request
from starlette.types import Message, Receive, Scope, Send

from app.authentication import AuthenticatedSessionMiddleware
from app.clients.auth_service import AuthenticatedUser
from app.clients.litellm import LITELLM_IDENTITY_CLIENT_STATE_KEY, LiteLLMIdentityClient, LiteLLMIdentityError
from app.core.config import LiteLLMSettings, get_settings

LITELLM_MOUNT_PATH = "/litellm"
LITELLM_CLIENT_STATE_KEY = "litellm_proxy_client"

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
_PROTECTED_REQUEST_HEADERS = {
    b"api-key",
    b"authorization",
    b"cookie",
    b"content-length",
    b"host",
    b"x-api-key",
    b"x-auth-context",
    b"x-encrypted-session-data",
    b"x-forwarded-for",
    b"x-forwarded-host",
    b"x-forwarded-proto",
    b"x-litellm-api-key",
    b"x-litellm-customer-id",
    b"x-litellm-end-user-id",
    b"x-litellm-spend-logs-metadata",
    b"x-request-id",
    b"x-session-refresh-token",
    b"x-team-id",
    b"x-user-id",
}
_PROTECTED_RESPONSE_HEADERS = {
    b"api-key",
    b"authorization",
    b"cache-control",
    b"expires",
    b"set-cookie",
    b"x-api-key",
    b"x-auth-context",
    b"x-encrypted-session-data",
    b"x-litellm-api-key",
    b"x-request-id",
    b"x-session-refresh-token",
}
_SAFE_IDENTIFIER = re.compile(r"^[A-Za-z0-9._:/-]{1,128}$")
_BAD_GATEWAY_BODY = b'{"detail":"LiteLLM upstream is unavailable"}'
_SERVICE_UNAVAILABLE_BODY = b'{"detail":"LiteLLM proxy is not ready"}'
_IDENTITY_SYNC_UNAVAILABLE_BODY = b'{"detail":"LiteLLM user/team synchronization is unavailable"}'
_ACCESS_DENIED_BODY = b'{"detail":"LiteLLM access denied"}'
_UNAUTHORIZED_BODY = b'{"detail":"Authentication required"}'
logger = logging.getLogger(__name__)


def _connection_tokens(headers: Iterable[tuple[bytes, bytes]]) -> set[bytes]:
    """Return additional hop-by-hop header names declared by Connection."""
    tokens: set[bytes] = set()
    for name, value in headers:
        if name.lower() != b"connection":
            continue
        tokens.update(token.strip().lower() for token in value.split(b",") if token.strip())
    return tokens


def _end_to_end_headers(headers: Iterable[tuple[bytes, bytes]]) -> list[tuple[bytes, bytes]]:
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


def _upstream_url(scope: Scope, settings: LiteLLMSettings, *, strip_mount_path: bool) -> httpx.URL:
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


async def _request_body(first_message: Message, receive: Receive) -> AsyncIterator[bytes]:
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
                (b"cache-control", b"no-store"),
            ],
        }
    )
    await send({"type": "http.response.body", "body": body})


async def _send_upstream_response(
    upstream_response: httpx.Response,
    send: Send,
    request_id: str,
    session_refresh_token: str | None,
) -> None:
    """Stream an upstream response and always release its pooled connection."""
    try:
        if upstream_response.status_code in {401, 403}:
            # Native key failures do not invalidate the DeputyDev session, and
            # their response bodies can expose backend-only credentials.
            await _send_error(send, 403, _ACCESS_DENIED_BODY)
            return
        response_headers = [
            (name, value)
            for name, value in _end_to_end_headers(upstream_response.headers.raw)
            if name.lower() not in _PROTECTED_RESPONSE_HEADERS
        ]
        response_headers.append((b"cache-control", b"no-store"))
        response_headers.append((b"x-request-id", request_id.encode("ascii")))
        if session_refresh_token:
            response_headers.append((b"x-session-refresh-token", session_refresh_token.encode("utf-8")))
        await send(
            {
                "type": "http.response.start",
                "status": upstream_response.status_code,
                "headers": response_headers,
            }
        )
        if upstream_response.is_stream_consumed:
            if upstream_response.content:
                await send({"type": "http.response.body", "body": upstream_response.content, "more_body": True})
        else:
            async for chunk in upstream_response.aiter_raw():
                if chunk:
                    await send({"type": "http.response.body", "body": chunk, "more_body": True})
        await send({"type": "http.response.body", "body": b"", "more_body": False})
    except OSError:
        return
    finally:
        await upstream_response.aclose()


def _safe_identifier(value: str | None, fallback: str) -> str:
    if value and _SAFE_IDENTIFIER.fullmatch(value):
        return value
    return fallback


async def authenticated_upstream_key(scope: Scope, settings: LiteLLMSettings, user: AuthenticatedUser) -> str:
    """Resolve a native user/team key for both proxy traffic and backend tools."""
    if not settings.identity_sync_enabled:
        return settings.api_key
    app = scope.get("app")
    identity_client = getattr(getattr(app, "state", None), LITELLM_IDENTITY_CLIENT_STATE_KEY, None)
    if not isinstance(identity_client, LiteLLMIdentityClient):
        raise LiteLLMIdentityError("LiteLLM identity synchronization client is unavailable")
    return await identity_client.ensure_identity(user)


async def _forward_authenticated_request(
    scope: Scope,
    receive: Receive,
    send: Send,
    client: httpx.AsyncClient,
    settings: LiteLLMSettings,
    strip_mount_path: bool,
    user: AuthenticatedUser,
    request_id: str,
) -> None:
    first_message = await receive()
    if first_message["type"] == "http.disconnect":
        return
    method = str(scope.get("method", "GET"))
    has_body = bool(first_message.get("body")) or bool(first_message.get("more_body", False))
    # Stream every path unchanged; LiteLLM owns payload validation and authorization.
    content: AsyncIterator[bytes] | None = _request_body(first_message, receive) if has_body else None

    try:
        upstream_api_key = await authenticated_upstream_key(scope, settings, user)
    except LiteLLMIdentityError as exc:
        logger.warning("LiteLLM identity synchronization failed: %s", exc)
        body = _ACCESS_DENIED_BODY if exc.status_code == 403 else _IDENTITY_SYNC_UNAVAILABLE_BODY
        await _send_error(send, exc.status_code, body)
        return

    upstream_url = _upstream_url(scope, settings, strip_mount_path=strip_mount_path)
    request_headers = [
        (name, value)
        for name, value in _end_to_end_headers(scope.get("headers", []))
        if name.lower() not in _PROTECTED_REQUEST_HEADERS
    ]
    # User authentication is complete in the backend. Stock LiteLLM receives
    # attribution only, never the user's session or a custom identity assertion.
    request_headers.extend(
        [
            (b"x-litellm-end-user-id", str(user.user_team_id).encode("ascii")),
            (b"x-request-id", request_id.encode("ascii")),
        ]
    )
    if upstream_api_key:
        request_headers.append((b"authorization", f"Bearer {upstream_api_key}".encode("ascii")))

    try:
        upstream_request = httpx.Request(
            method=method,
            url=upstream_url,
            headers=request_headers,
            content=content,
        )
        upstream_response = await client.send(upstream_request, stream=True)
    except httpx.HTTPError:
        logger.warning("LiteLLM upstream request failed", exc_info=True)
        await _send_error(send, 502, _BAD_GATEWAY_BODY)
        return

    await _send_upstream_response(upstream_response, send, request_id, user.session_refresh_token)


class LiteLLMProxy:
    """Authenticate and stream all LiteLLM HTTP paths without inspecting bodies."""

    def __init__(self, settings: LiteLLMSettings, *, strip_mount_path: bool = False) -> None:
        self.settings = settings
        self.strip_mount_path = strip_mount_path

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            if scope["type"] == "websocket":
                await send({"type": "websocket.close", "code": 1008})
            return

        app = scope.get("app")
        client: httpx.AsyncClient | None = getattr(getattr(app, "state", None), LITELLM_CLIENT_STATE_KEY, None)
        if client is None:
            await _send_error(send, 503, _SERVICE_UNAVAILABLE_BODY)
            return

        incoming = Request(scope)
        request_id = _safe_identifier(incoming.headers.get("x-request-id"), str(uuid4()))
        user = getattr(incoming.state, "authenticated_user", None)
        encrypted_session = getattr(incoming.state, "encrypted_session_data", None)
        if not isinstance(user, AuthenticatedUser) or not isinstance(encrypted_session, str) or not encrypted_session:
            # Never forward if this proxy is mounted without its auth middleware.
            await _send_error(send, 401, _UNAUTHORIZED_BODY)
            return

        await _forward_authenticated_request(
            scope=scope,
            receive=receive,
            send=send,
            client=client,
            settings=self.settings,
            strip_mount_path=self.strip_mount_path,
            user=user,
            request_id=request_id,
        )


def mount_litellm_proxy(app: FastAPI) -> None:
    """Expose authenticated LiteLLM traffic before the frontend catch-all."""
    settings = get_settings().litellm
    app.add_route(
        LITELLM_MOUNT_PATH,
        AuthenticatedSessionMiddleware(LiteLLMProxy(settings, strip_mount_path=True)),
        name="litellm-proxy-root",
        include_in_schema=False,
    )
    app.mount(LITELLM_MOUNT_PATH, AuthenticatedSessionMiddleware(LiteLLMProxy(settings)), name="litellm-proxy")
    logger.info("LiteLLM proxy mounted at %s", LITELLM_MOUNT_PATH)
