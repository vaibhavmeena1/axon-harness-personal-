"""Axon-authenticated LiteLLM proxy policies over the shared streaming lifecycle."""

import hashlib
import logging
from functools import partial
from urllib.parse import parse_qsl, unquote_to_bytes, urlencode

import httpx
from fastapi import FastAPI, Request
from starlette.types import Receive, Scope, Send

from app.authentication import AuthenticatedSessionMiddleware
from app.clients.auth_service import AuthenticatedUser
from app.clients.litellm.dependencies import LITELLM_IDENTITY_CLIENT_STATE_KEY, LITELLM_TRANSPORT_STATE_KEY
from app.clients.litellm.identity import LiteLLMIdentityClient, LiteLLMIdentityError
from app.core.config import LiteLLMSettings
from app.proxies.litellm_common import (
    ACCESS_DENIED_BODY,
    IDENTITY_SYNC_UNAVAILABLE_BODY,
    LITELLM_MOUNT_PATH,
    PROTECTED_REQUEST_HEADERS,
    PROTECTED_RESPONSE_HEADERS,
    SERVICE_UNAVAILABLE_BODY,
    UNAUTHORIZED_BODY,
    ForwardingError,
    LiteLLMRequestLoggingMiddleware,
    ResponseHead,
    UpstreamRequest,
    end_to_end_headers,
    forward_stream,
    get_diagnostics,
    reject_non_http,
    send_error,
    validated_request_path,
)

logger = logging.getLogger(__name__)


def _metadata_query_string(method: str, raw_path: bytes, query_string: bytes, api_key: str) -> bytes:
    """Pin key-info to self and prevent LiteLLM echoing a backend credential."""
    if method != "GET" or unquote_to_bytes(raw_path) != b"/key/info" or not api_key:
        return query_string
    params = parse_qsl(query_string.decode("ascii", errors="replace"), keep_blank_values=True)
    params = [(name, value) for name, value in params if name != "key"]
    params.append(("key", hashlib.sha256(api_key.encode("ascii")).hexdigest()))
    return urlencode(params).encode("ascii")


async def _api_request(
    request_id: str, *, scope: Scope, raw_path: bytes, identity: LiteLLMIdentityClient, user: AuthenticatedUser
) -> UpstreamRequest:
    """Resolve a verified native key and strip all caller credentials/assertions."""
    diagnostic = get_diagnostics(scope)
    if diagnostic is not None:
        diagnostic.stage = "identity_sync"
        settings = getattr(identity, "settings", None)
        if isinstance(settings, LiteLLMSettings):
            diagnostic.credential_mode = "virtual_key" if settings.identity_sync_enabled else "configured_key"
    try:
        api_key = await identity.authenticated_key(user)
    except LiteLLMIdentityError as exc:
        body = ACCESS_DENIED_BODY if exc.status_code == 403 else IDENTITY_SYNC_UNAVAILABLE_BODY
        raise ForwardingError(
            exc.status_code,
            body,
            "identity_sync_failed",
            error_type=type(exc).__name__,
            upstream_status=exc.upstream_status_code,
        ) from exc
    headers = [
        (name, value)
        for name, value in end_to_end_headers(scope.get("headers", []))
        if name.lower() not in PROTECTED_REQUEST_HEADERS
    ]
    headers.extend(
        [
            (b"x-litellm-end-user-id", str(user.user_id).encode("ascii")),
            (b"x-request-id", request_id.encode("ascii")),
        ]
    )
    if api_key:
        headers.append((b"authorization", f"Bearer {api_key}".encode("ascii")))
    query = _metadata_query_string(str(scope.get("method", "GET")), raw_path, scope.get("query_string", b""), api_key)
    return UpstreamRequest(headers, query)


def _api_response(response: httpx.Response, request_id: str, *, session_refresh_token: str | None) -> ResponseHead:
    """Sanitize native key denials and never expose upstream cookies or keys."""
    reason = {401: "upstream_authentication_failed", 403: "upstream_permission_denied"}.get(
        response.status_code, "upstream_http_error" if response.is_error else "none"
    )
    if response.status_code in {401, 403}:
        return ResponseHead(
            403,
            [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(ACCESS_DENIED_BODY)).encode("ascii")),
                (b"cache-control", b"no-store"),
            ],
            ACCESS_DENIED_BODY,
            reason,
        )
    headers = [
        (name, value)
        for name, value in end_to_end_headers(response.headers.raw)
        if name.lower() not in PROTECTED_RESPONSE_HEADERS
    ]
    headers.extend([(b"cache-control", b"no-store"), (b"x-request-id", request_id.encode("ascii"))])
    if session_refresh_token:
        headers.append((b"x-session-refresh-token", session_refresh_token.encode("utf-8")))
    return ResponseHead(response.status_code, headers, reason=reason)


class LiteLLMProxy:
    """Authenticate and stream all LiteLLM HTTP paths without inspecting bodies."""

    def __init__(self, *, strip_mount_path: bool = False) -> None:
        self.strip_mount_path = strip_mount_path

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if await reject_non_http(scope, send):
            return

        diagnostic = get_diagnostics(scope)
        if diagnostic is not None:
            diagnostic.stage = "proxy"
        app = scope.get("app")
        transport = getattr(getattr(app, "state", None), LITELLM_TRANSPORT_STATE_KEY, None)
        if transport is None:
            if diagnostic is not None:
                diagnostic.reason = "transport_not_initialized"
            await send_error(send, 503, SERVICE_UNAVAILABLE_BODY)
            return

        incoming = Request(scope)
        user = getattr(incoming.state, "authenticated_user", None)
        encrypted_session = getattr(incoming.state, "encrypted_session_data", None)
        if not isinstance(user, AuthenticatedUser) or not isinstance(encrypted_session, str) or not encrypted_session:
            # Never forward if this proxy is mounted without its auth middleware.
            if diagnostic is not None:
                diagnostic.reason = "authenticated_identity_missing"
            await send_error(send, 401, UNAUTHORIZED_BODY)
            return

        identity = getattr(getattr(app, "state", None), LITELLM_IDENTITY_CLIENT_STATE_KEY, None)
        if identity is None:
            if diagnostic is not None:
                diagnostic.reason = "identity_client_not_initialized"
            await send_error(send, 503, IDENTITY_SYNC_UNAVAILABLE_BODY)
            return

        raw_path = await validated_request_path(
            scope, send, strip_mount_path=self.strip_mount_path, mount_path=LITELLM_MOUNT_PATH
        )
        if raw_path is None:
            return
        await forward_stream(
            scope,
            receive,
            send,
            transport,
            raw_path,
            build_request=partial(_api_request, scope=scope, raw_path=raw_path, identity=identity, user=user),
            response_policy=partial(_api_response, session_refresh_token=user.session_refresh_token),
        )


def mount_litellm_proxy(app: FastAPI) -> None:
    """Expose authenticated LiteLLM traffic before the frontend catch-all."""
    app.add_route(
        LITELLM_MOUNT_PATH,
        LiteLLMRequestLoggingMiddleware(
            AuthenticatedSessionMiddleware(LiteLLMProxy(strip_mount_path=True)), strip_mount_path=True, logger=logger
        ),
        name="litellm-proxy-root",
        include_in_schema=False,
    )
    app.mount(
        LITELLM_MOUNT_PATH,
        LiteLLMRequestLoggingMiddleware(AuthenticatedSessionMiddleware(LiteLLMProxy()), logger=logger),
        name="litellm-proxy",
    )
    logger.info("LiteLLM proxy mounted at %s", LITELLM_MOUNT_PATH)
