"""Browser pass-through: LiteLLM, not Axon, authenticates dashboard requests."""

from time import monotonic
from urllib.parse import urlsplit, urlunsplit
from uuid import uuid4

import httpx
from fastapi import FastAPI, Request
from starlette.types import Receive, Scope, Send

from app.clients.litellm.dependencies import LITELLM_TRANSPORT_STATE_KEY
from app.clients.litellm.transport import LiteLLMTransport, validate_raw_path
from app.proxies.litellm import (
    _BAD_GATEWAY_BODY,
    _INVALID_PATH_BODY,
    _PROTECTED_REQUEST_HEADERS,
    _PROTECTED_RESPONSE_HEADERS,
    _SERVICE_UNAVAILABLE_BODY,
    LiteLLMRequestLoggingMiddleware,
    _diagnostics,
    _end_to_end_headers,
    _relative_raw_path,
    _request_body,
    _safe_identifier,
    _send_error,
)

LITELLM_UI_MOUNT_PATH = "/litellm-admin"
# Native LiteLLM credentials belong to the browser, never to the backend.
_REQUEST_EXCLUDED = _PROTECTED_REQUEST_HEADERS - {
    b"authorization",
    b"api-key",
    b"x-api-key",
    b"x-litellm-api-key",
    b"cookie",
}
_REQUEST_EXCLUDED |= {b"forwarded", b"x-forwarded-prefix", b"x-forwarded-port", b"x-real-ip"}
_RESPONSE_EXCLUDED = _PROTECTED_RESPONSE_HEADERS - {b"set-cookie"}
_AXON_COOKIE_NAMES = {"encrypted_session_data", "extension_auth_token", "session_refresh_token", "axon_session"}


def _browser_headers(scope: Scope, request_id: str) -> list[tuple[bytes, bytes]]:
    headers = []
    for name, value in _end_to_end_headers(scope.get("headers", [])):
        if name.lower() in _REQUEST_EXCLUDED:
            continue
        if name.lower() == b"cookie":
            # Axon currently uses bearer sessions, but never forward its named
            # session fields if a browser also supplies them as cookies.
            cookies = [
                cookie.strip()
                for cookie in value.split(b";")
                if cookie.partition(b"=")[0].strip().decode("latin-1").lower() not in _AXON_COOKIE_NAMES
            ]
            value = b"; ".join(cookie for cookie in cookies if cookie)
            if not value:
                continue
        headers.append((name, value))
    # Do not trust caller-supplied forwarding/identity assertions. ASGI's scheme
    # is set by the server (including its trusted-ingress proxy-header handling).
    request = Request(scope)
    headers.extend(
        [
            (b"x-request-id", request_id.encode("ascii")),
            (b"x-forwarded-proto", request.url.scheme.encode("ascii")),
            (b"x-forwarded-host", request.headers.get("host", request.url.netloc).encode("latin-1")),
        ]
    )
    return headers


def _public_location(value: bytes, transport: LiteLLMTransport) -> bytes:
    """Keep private-origin redirects on the public site; leave SSO redirects alone."""
    location = urlsplit(value.decode("latin-1"))
    upstream = urlsplit(transport.settings.upstream_url)
    if location.netloc and location.netloc.lower() != upstream.netloc.lower():
        return value
    if not location.path.startswith("/"):
        return value
    root = transport.settings.upstream_root_path.rstrip("/")
    path = location.path
    if root and path != root and not path.startswith(root + "/"):
        path = root + path
    # Root-relative URLs avoid trusting the caller's Host for redirect targets.
    return urlunsplit(("", "", path, location.query, location.fragment)).encode("latin-1")


async def _send_browser_response(response: httpx.Response, send: Send, transport: LiteLLMTransport) -> None:
    try:
        headers = []
        for name, value in _end_to_end_headers(response.headers.raw):
            if name.lower() in _RESPONSE_EXCLUDED:
                continue
            if name.lower() == b"location":
                value = _public_location(value, transport)
            # Preserve duplicate Set-Cookie headers and their security attributes.
            headers.append((name, value))
        headers.append((b"cache-control", b"no-store"))
        await send({"type": "http.response.start", "status": response.status_code, "headers": headers})
        if response.is_stream_consumed:
            if response.content:
                await send({"type": "http.response.body", "body": response.content, "more_body": True})
        else:
            async for chunk in response.aiter_raw():
                if chunk:
                    await send({"type": "http.response.body", "body": chunk, "more_body": True})
        await send({"type": "http.response.body", "body": b"", "more_body": False})
    except OSError:
        return
    finally:
        await response.aclose()


class LiteLLMUIProxy:
    """Forward the entire dashboard namespace without granting any credentials."""

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
            diagnostic.credential_mode = "browser"
        transport = getattr(getattr(scope.get("app"), "state", None), LITELLM_TRANSPORT_STATE_KEY, None)
        if transport is None:
            if diagnostic is not None:
                diagnostic.reason = "transport_not_initialized"
            await _send_error(send, 503, _SERVICE_UNAVAILABLE_BODY)
            return
        raw_path = _relative_raw_path(scope, strip_mount_path=self.strip_mount_path, mount_path=LITELLM_UI_MOUNT_PATH)
        try:
            validate_raw_path(raw_path)
        except ValueError:
            if diagnostic is not None:
                diagnostic.reason = "invalid_path"
            await _send_error(send, 400, _INVALID_PATH_BODY)
            return
        if raw_path == b"/":
            # The configured root is also LiteLLM's browser-visible root. This
            # works when ingress strips /axon without setting ASGI root_path.
            root = transport.settings.upstream_root_path.rstrip("/") or LITELLM_UI_MOUNT_PATH
            await send(
                {
                    "type": "http.response.start",
                    "status": 307,
                    "headers": [(b"location", (root + "/ui/").encode("ascii")), (b"cache-control", b"no-store")],
                }
            )
            await send({"type": "http.response.body", "body": b""})
            return
        await self._forward(scope, receive, send, transport, raw_path)

    async def _forward(
        self, scope: Scope, receive: Receive, send: Send, transport: LiteLLMTransport, raw_path: bytes
    ) -> None:
        first_message = await receive()
        if first_message["type"] == "http.disconnect":
            return
        has_body = bool(first_message.get("body")) or bool(first_message.get("more_body", False))
        diagnostic = _diagnostics(scope)
        request_id = (
            diagnostic.request_id
            if diagnostic is not None
            else _safe_identifier(Request(scope).headers.get("x-request-id"), str(uuid4()))
        )
        if diagnostic is not None:
            diagnostic.stage = "upstream"
        started = monotonic()
        try:
            # send_stream constructs an httpx.Request directly: shared-client
            # cookies/auth defaults are not merged into this browser's request.
            response = await transport.send_stream(
                str(scope.get("method", "GET")),
                raw_path,
                query_string=scope.get("query_string", b""),
                headers=_browser_headers(scope, request_id),
                content=_request_body(first_message, receive) if has_body else None,
            )
        except httpx.HTTPError as exc:
            if diagnostic is not None:
                diagnostic.reason = "upstream_transport_failed"
                diagnostic.error_type = type(exc).__name__
            await _send_error(send, 502, _BAD_GATEWAY_BODY)
            return
        finally:
            if diagnostic is not None:
                diagnostic.upstream_duration_ms = round((monotonic() - started) * 1000, 1)
        if diagnostic is not None:
            diagnostic.upstream_status = response.status_code
            diagnostic.reason = "upstream_http_error" if response.is_error else "none"
        # Unlike the API proxy, native 401/403 responses belong to LiteLLM's
        # login flow and must not be converted into Axon authentication errors.
        await _send_browser_response(response, send, transport)


def mount_litellm_ui_proxy(app: FastAPI) -> None:
    """Opt-in browser mount, registered before the frontend catch-all."""
    app.add_route(
        LITELLM_UI_MOUNT_PATH,
        LiteLLMRequestLoggingMiddleware(
            LiteLLMUIProxy(strip_mount_path=True), strip_mount_path=True, mount_path=LITELLM_UI_MOUNT_PATH
        ),
        name="litellm-ui-root",
        include_in_schema=False,
    )
    app.mount(
        LITELLM_UI_MOUNT_PATH,
        LiteLLMRequestLoggingMiddleware(LiteLLMUIProxy(), mount_path=LITELLM_UI_MOUNT_PATH),
        name="litellm-ui",
    )
