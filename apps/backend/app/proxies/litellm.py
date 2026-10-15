"""Authenticated HTTP proxy for the privately hosted LiteLLM service."""

import asyncio
import hashlib
import logging
import re
from collections.abc import AsyncIterator, Iterable
from dataclasses import dataclass
from time import monotonic
from urllib.parse import parse_qsl, quote, unquote_to_bytes, urlencode
from uuid import uuid4

import httpx
from fastapi import FastAPI, Request
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.authentication import AuthenticatedSessionMiddleware
from app.clients.auth_service import AuthenticatedUser
from app.clients.litellm.dependencies import LITELLM_IDENTITY_CLIENT_STATE_KEY, LITELLM_TRANSPORT_STATE_KEY
from app.clients.litellm.identity import LiteLLMIdentityClient, LiteLLMIdentityError
from app.clients.litellm.transport import LiteLLMTransport, validate_raw_path
from app.core.config import LiteLLMSettings

LITELLM_MOUNT_PATH = "/litellm"

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
_INVALID_PATH_BODY = b'{"detail":"Invalid LiteLLM request path"}'
_BAD_GATEWAY_BODY = b'{"detail":"LiteLLM upstream is unavailable"}'
_SERVICE_UNAVAILABLE_BODY = b'{"detail":"LiteLLM proxy is not ready"}'
_IDENTITY_SYNC_UNAVAILABLE_BODY = b'{"detail":"LiteLLM user/team synchronization is unavailable"}'
_ACCESS_DENIED_BODY = b'{"detail":"LiteLLM access denied"}'
_UNAUTHORIZED_BODY = b'{"detail":"Authentication required"}'
logger = logging.getLogger(__name__)

# Log only static endpoint names, never arbitrary path IDs, queries, or payloads.
_DIAGNOSTIC_PATHS = frozenset(
    {
        "/",
        "/health",
        "/health/liveliness",
        "/health/readiness",
        "/key/info",
        "/mcp",
        "/model/info",
        "/models",
        "/team/info",
        "/team/list",
        "/user/info",
        "/v2/user/info",
        "/v1/models",
        "/chat/completions",
        "/v1/chat/completions",
        "/completions",
        "/v1/completions",
        "/responses",
        "/v1/responses",
        "/embeddings",
        "/v1/embeddings",
        "/messages",
        "/v1/messages",
    }
)
_DIAGNOSTICS_STATE_KEY = "litellm_request_diagnostics"


@dataclass
class _RequestDiagnostics:
    request_id: str
    stage: str = "session_auth"
    reason: str = "none"
    upstream_status: int | None = None
    upstream_duration_ms: float | None = None
    credential_mode: str = "unresolved"
    error_type: str = "none"

    def log_result(self, *, method: str, path: str, status: int | None, completed: bool, started: float) -> None:
        if self.reason == "none":
            if self.stage == "session_auth" and status is not None and status >= 400:
                self.reason = "session_auth_failed"
            elif not completed:
                self.reason = "response_incomplete"
        failed = status is None or status >= 400 or self.reason != "none"
        level = logging.WARNING if failed else logging.INFO
        if self.reason in {"client_disconnected", "request_cancelled"}:
            level = logging.INFO
        logger.log(
            level,
            "LiteLLM request request_id=%s method=%s path=%s stage=%s reason=%s "
            "upstream_status=%s status=%s credential_mode=%s upstream_duration_ms=%s "
            "duration_ms=%.1f completed=%s error_type=%s",
            self.request_id,
            method,
            path,
            self.stage,
            self.reason,
            self.upstream_status if self.upstream_status is not None else "none",
            status if status is not None else "none",
            self.credential_mode,
            self.upstream_duration_ms if self.upstream_duration_ms is not None else "none",
            (monotonic() - started) * 1000,
            str(completed).lower(),
            self.error_type,
        )


def _diagnostics(scope: Scope) -> _RequestDiagnostics | None:
    return scope.get("state", {}).get(_DIAGNOSTICS_STATE_KEY)


class LiteLLMRequestLoggingMiddleware:
    """Correlate session, provisioning, upstream, and streaming failures safely."""

    def __init__(self, app: ASGIApp, *, strip_mount_path: bool = False, mount_path: str = LITELLM_MOUNT_PATH) -> None:
        self.app = app
        self.strip_mount_path = strip_mount_path
        self.mount_path = mount_path

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        started = monotonic()
        request = Request(scope)
        diagnostic = _RequestDiagnostics(_safe_identifier(request.headers.get("x-request-id"), str(uuid4())))
        request.state.litellm_request_diagnostics = diagnostic
        raw_path = _relative_raw_path(scope, strip_mount_path=self.strip_mount_path, mount_path=self.mount_path).decode(
            "ascii", errors="replace"
        )
        path = raw_path if raw_path in _DIAGNOSTIC_PATHS else "<other>"
        method = str(scope.get("method", "GET"))
        method = method if method in {"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"} else "<other>"
        status: int | None = None
        completed = False

        async def send_correlated(message: Message) -> None:
            nonlocal status, completed
            if message["type"] == "http.response.start":
                status = message["status"]
                headers = [
                    (name, value) for name, value in message.get("headers", []) if name.lower() != b"x-request-id"
                ]
                headers.append((b"x-request-id", diagnostic.request_id.encode("ascii")))
                message = {**message, "headers": headers}
            try:
                await send(message)
            except OSError as exc:
                diagnostic.stage = "downstream_stream"
                diagnostic.reason = "client_disconnected"
                diagnostic.error_type = type(exc).__name__
                raise
            if message["type"] == "http.response.body" and not message.get("more_body", False):
                completed = True

        try:
            await self.app(scope, receive, send_correlated)
        except asyncio.CancelledError:
            diagnostic.reason = "request_cancelled"
            diagnostic.error_type = "CancelledError"
            raise
        except httpx.HTTPError as exc:
            diagnostic.stage = "upstream_stream"
            diagnostic.reason = "upstream_stream_failed"
            diagnostic.error_type = type(exc).__name__
            raise
        finally:
            diagnostic.log_result(method=method, path=path, status=status, completed=completed, started=started)


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


def _relative_raw_path(scope: Scope, *, strip_mount_path: bool, mount_path: str = LITELLM_MOUNT_PATH) -> bytes:
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
        encoded_mount_path = mount_path.encode("ascii")
        if relative_path == encoded_mount_path:
            relative_path = b"/"
        elif relative_path.startswith(encoded_mount_path + b"/"):
            relative_path = relative_path[len(encoded_mount_path) :]

    if not relative_path:
        return b"/"
    if not relative_path.startswith(b"/"):
        return b"/" + relative_path
    return relative_path


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
            # Native key failures do not invalidate the Axon session, and
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


def _metadata_query_string(method: str, raw_path: bytes, query_string: bytes, api_key: str) -> bytes:
    """Pin key-info to self and prevent LiteLLM echoing a backend credential."""
    if method != "GET" or unquote_to_bytes(raw_path) != b"/key/info" or not api_key:
        return query_string
    params = parse_qsl(query_string.decode("ascii", errors="replace"), keep_blank_values=True)
    params = [(name, value) for name, value in params if name != "key"]
    params.append(("key", hashlib.sha256(api_key.encode("ascii")).hexdigest()))
    return urlencode(params).encode("ascii")


def _prepare_identity_diagnostics(scope: Scope, identity: LiteLLMIdentityClient) -> _RequestDiagnostics | None:
    diagnostic = _diagnostics(scope)
    if diagnostic is not None:
        diagnostic.stage = "identity_sync"
        settings = getattr(identity, "settings", None)
        if isinstance(settings, LiteLLMSettings):
            diagnostic.credential_mode = "virtual_key" if settings.identity_sync_enabled else "configured_key"
    return diagnostic


async def _forward_authenticated_request(
    scope: Scope,
    receive: Receive,
    send: Send,
    transport: LiteLLMTransport,
    identity: LiteLLMIdentityClient,
    strip_mount_path: bool,
    user: AuthenticatedUser,
    request_id: str,
) -> None:
    raw_path = _relative_raw_path(scope, strip_mount_path=strip_mount_path)
    try:
        validate_raw_path(raw_path)
    except ValueError:
        diagnostic = _diagnostics(scope)
        if diagnostic is not None:
            diagnostic.reason = "invalid_path"
        await _send_error(send, 400, _INVALID_PATH_BODY)
        return

    await _forward_safe_request(
        scope=scope,
        receive=receive,
        send=send,
        transport=transport,
        identity=identity,
        raw_path=raw_path,
        user=user,
        request_id=request_id,
    )


async def _forward_safe_request(
    scope: Scope,
    receive: Receive,
    send: Send,
    transport: LiteLLMTransport,
    identity: LiteLLMIdentityClient,
    raw_path: bytes,
    user: AuthenticatedUser,
    request_id: str,
) -> None:
    first_message = await receive()
    if first_message["type"] == "http.disconnect":
        return
    method = str(scope.get("method", "GET"))
    has_body = bool(first_message.get("body")) or bool(first_message.get("more_body", False))
    # Stream safe paths unchanged; LiteLLM owns payload validation and authorization.
    content: AsyncIterator[bytes] | None = _request_body(first_message, receive) if has_body else None

    diagnostic = _prepare_identity_diagnostics(scope, identity)
    try:
        upstream_api_key = await identity.authenticated_key(user)
    except LiteLLMIdentityError as exc:
        if diagnostic is not None:
            diagnostic.reason = "identity_sync_failed"
            diagnostic.upstream_status = exc.upstream_status_code
            diagnostic.error_type = type(exc).__name__
        body = _ACCESS_DENIED_BODY if exc.status_code == 403 else _IDENTITY_SYNC_UNAVAILABLE_BODY
        await _send_error(send, exc.status_code, body)
        return

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

    query_string = _metadata_query_string(method, raw_path, scope.get("query_string", b""), upstream_api_key)
    upstream_started = monotonic()
    if diagnostic is not None:
        diagnostic.stage = "upstream"
    try:
        upstream_response = await transport.send_stream(
            method,
            raw_path,
            query_string=query_string,
            headers=request_headers,
            content=content,
        )
    except httpx.HTTPError as exc:
        if diagnostic is not None:
            diagnostic.reason = "upstream_transport_failed"
            diagnostic.error_type = type(exc).__name__
        await _send_error(send, 502, _BAD_GATEWAY_BODY)
        return
    finally:
        if diagnostic is not None:
            diagnostic.upstream_duration_ms = round((monotonic() - upstream_started) * 1000, 1)

    if diagnostic is not None:
        diagnostic.upstream_status = upstream_response.status_code
        diagnostic.reason = {
            401: "upstream_authentication_failed",
            403: "upstream_permission_denied",
        }.get(upstream_response.status_code, "upstream_http_error" if upstream_response.is_error else "none")

    await _send_upstream_response(upstream_response, send, request_id, user.session_refresh_token)


class LiteLLMProxy:
    """Authenticate and stream all LiteLLM HTTP paths without inspecting bodies."""

    def __init__(self, *, strip_mount_path: bool = False) -> None:
        self.strip_mount_path = strip_mount_path

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            if scope["type"] == "websocket":
                await send({"type": "websocket.close", "code": 1008})
            return

        diagnostic = _diagnostics(scope)
        if diagnostic is not None:
            diagnostic.stage = "proxy"
        app = scope.get("app")
        transport = getattr(getattr(app, "state", None), LITELLM_TRANSPORT_STATE_KEY, None)
        if transport is None:
            if diagnostic is not None:
                diagnostic.reason = "transport_not_initialized"
            await _send_error(send, 503, _SERVICE_UNAVAILABLE_BODY)
            return

        incoming = Request(scope)
        request_id = (
            diagnostic.request_id
            if diagnostic is not None
            else _safe_identifier(incoming.headers.get("x-request-id"), str(uuid4()))
        )
        user = getattr(incoming.state, "authenticated_user", None)
        encrypted_session = getattr(incoming.state, "encrypted_session_data", None)
        if not isinstance(user, AuthenticatedUser) or not isinstance(encrypted_session, str) or not encrypted_session:
            # Never forward if this proxy is mounted without its auth middleware.
            if diagnostic is not None:
                diagnostic.reason = "authenticated_identity_missing"
            await _send_error(send, 401, _UNAUTHORIZED_BODY)
            return

        identity = getattr(getattr(app, "state", None), LITELLM_IDENTITY_CLIENT_STATE_KEY, None)
        if identity is None:
            if diagnostic is not None:
                diagnostic.reason = "identity_client_not_initialized"
            await _send_error(send, 503, _IDENTITY_SYNC_UNAVAILABLE_BODY)
            return

        await _forward_authenticated_request(
            scope=scope,
            receive=receive,
            send=send,
            transport=transport,
            identity=identity,
            strip_mount_path=self.strip_mount_path,
            user=user,
            request_id=request_id,
        )


def mount_litellm_proxy(app: FastAPI) -> None:
    """Expose authenticated LiteLLM traffic before the frontend catch-all."""
    app.add_route(
        LITELLM_MOUNT_PATH,
        LiteLLMRequestLoggingMiddleware(
            AuthenticatedSessionMiddleware(LiteLLMProxy(strip_mount_path=True)), strip_mount_path=True
        ),
        name="litellm-proxy-root",
        include_in_schema=False,
    )
    app.mount(
        LITELLM_MOUNT_PATH,
        LiteLLMRequestLoggingMiddleware(AuthenticatedSessionMiddleware(LiteLLMProxy())),
        name="litellm-proxy",
    )
    logger.info("LiteLLM proxy mounted at %s", LITELLM_MOUNT_PATH)
