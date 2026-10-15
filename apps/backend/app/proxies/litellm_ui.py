"""Browser credential/response policies over the shared LiteLLM streaming lifecycle."""

import logging
from functools import partial
from urllib.parse import unquote_to_bytes, urlsplit, urlunsplit

import httpx
from fastapi import FastAPI, Request
from starlette.types import Receive, Scope, Send

from app.clients.litellm.dependencies import LITELLM_TRANSPORT_STATE_KEY
from app.clients.litellm.transport import LiteLLMTransport
from app.proxies.litellm_common import (
    PROTECTED_REQUEST_HEADERS,
    PROTECTED_RESPONSE_HEADERS,
    SERVICE_UNAVAILABLE_BODY,
    BodyLimits,
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

LITELLM_UI_MOUNT_PATH = "/litellm-admin"
# Native LiteLLM credentials belong to the browser, never to the backend.
_REQUEST_EXCLUDED = PROTECTED_REQUEST_HEADERS - {
    b"authorization",
    b"api-key",
    b"x-api-key",
    b"x-litellm-api-key",
    b"cookie",
}
_REQUEST_EXCLUDED |= {b"forwarded", b"x-forwarded-prefix", b"x-forwarded-port", b"x-real-ip"}
_RESPONSE_EXCLUDED = PROTECTED_RESPONSE_HEADERS - {b"set-cookie"}
_AXON_COOKIE_NAMES = {"encrypted_session_data", "extension_auth_token", "session_refresh_token", "axon_session"}


def _browser_headers(scope: Scope, request_id: str) -> list[tuple[bytes, bytes]]:
    """Retain LiteLLM credentials/cookies, stripping Axon identity and forwarding assertions."""
    headers = []
    for name, value in end_to_end_headers(scope.get("headers", [])):
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


def _public_root(scope: Scope, transport: LiteLLMTransport) -> str:
    """Share the configured external prefix, or derive the mounted ASGI prefix."""
    root = transport.settings.upstream_root_path.rstrip("/")
    if root:
        return root
    root = str(scope.get("root_path", "")).rstrip("/")
    return root if root.endswith(LITELLM_UI_MOUNT_PATH) else root + LITELLM_UI_MOUNT_PATH


def _public_location(value: bytes, transport: LiteLLMTransport, public_root: str) -> bytes:
    """Rewrite private/root-relative redirects; preserve SSO and malformed headers."""
    try:
        location = urlsplit(value.decode("latin-1"))
    except ValueError:
        return value
    upstream = urlsplit(transport.settings.upstream_url)
    if location.netloc and location.netloc.lower() != upstream.netloc.lower():
        return value
    if not location.path.startswith("/"):
        return value
    path = location.path
    if path != public_root and not path.startswith(public_root + "/"):
        path = public_root + path
    return urlunsplit(("", "", path, location.query, location.fragment)).encode("latin-1")


def _cacheable_asset(response: httpx.Response, raw_path: bytes) -> bool:
    """Trust native caching only for successful static assets without session effects."""
    path = unquote_to_bytes(raw_path)
    static = path.startswith((b"/ui/_next/static/", b"/_next/static/", b"/litellm-asset-prefix/_next/static/"))
    vary = {token.strip().lower() for token in response.headers.get("vary", "").split(",")}
    return (
        static
        and response.status_code in {200, 304}
        and "cache-control" in response.headers
        and "set-cookie" not in response.headers
        and not vary.intersection({"*", "cookie", "authorization"})
    )


def _browser_response(
    response: httpx.Response, request_id: str, *, transport: LiteLLMTransport, raw_path: bytes, public_root: str
) -> ResponseHead:
    """Preserve native auth and duplicate cookies; shared forwarding owns bytes/closure."""
    cacheable = _cacheable_asset(response, raw_path)
    excluded = _RESPONSE_EXCLUDED - {b"cache-control", b"expires"} if cacheable else _RESPONSE_EXCLUDED
    headers = []
    for name, value in end_to_end_headers(response.headers.raw):
        if name.lower() in excluded:
            continue
        if name.lower() == b"location":
            value = _public_location(value, transport, public_root)
        headers.append((name, value))
    if not cacheable:
        headers.append((b"cache-control", b"no-store"))
    return ResponseHead(response.status_code, headers, reason="upstream_http_error" if response.is_error else "none")


async def _browser_request(request_id: str, *, scope: Scope) -> UpstreamRequest:
    """Use browser credentials verbatim; never resolve/inject a backend key."""
    return UpstreamRequest(_browser_headers(scope, request_id), scope.get("query_string", b""))


class LiteLLMUIProxy:
    """Forward the entire dashboard namespace without granting any credentials."""

    def __init__(self, *, strip_mount_path: bool = False) -> None:
        self.strip_mount_path = strip_mount_path

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        """Validate the mount and delegate bounded body/response ownership to forward_stream."""
        if await reject_non_http(scope, send):
            return
        diagnostic = get_diagnostics(scope)
        if diagnostic is not None:
            diagnostic.stage = "proxy"
            diagnostic.credential_mode = "browser"
        transport = getattr(getattr(scope.get("app"), "state", None), LITELLM_TRANSPORT_STATE_KEY, None)
        if transport is None:
            if diagnostic is not None:
                diagnostic.reason = "transport_not_initialized"
            await send_error(send, 503, SERVICE_UNAVAILABLE_BODY)
            return
        raw_path = await validated_request_path(
            scope, send, strip_mount_path=self.strip_mount_path, mount_path=LITELLM_UI_MOUNT_PATH
        )
        if raw_path is None:
            return
        root = _public_root(scope, transport)
        if raw_path == b"/":
            # The configured root is also LiteLLM's browser-visible root. This
            # works when ingress strips /axon without setting ASGI root_path.
            await send(
                {
                    "type": "http.response.start",
                    "status": 307,
                    "headers": [(b"location", (root + "/ui/").encode("ascii")), (b"cache-control", b"no-store")],
                }
            )
            await send({"type": "http.response.body", "body": b""})
            return
        settings = transport.settings
        limits = BodyLimits(
            idle_timeout_seconds=settings.ui_body_idle_timeout_seconds,
            write_timeout_seconds=settings.ui_write_timeout_seconds,
            request_timeout_seconds=settings.ui_request_timeout_seconds,
            max_bytes=settings.ui_max_request_body_bytes,
        )
        await forward_stream(
            scope,
            receive,
            send,
            transport,
            raw_path,
            build_request=partial(_browser_request, scope=scope),
            response_policy=partial(_browser_response, transport=transport, raw_path=raw_path, public_root=root),
            limits=limits,
        )


def mount_litellm_ui_proxy(app: FastAPI) -> None:
    """Opt-in browser mount, registered before the frontend catch-all."""
    app.add_route(
        LITELLM_UI_MOUNT_PATH,
        LiteLLMRequestLoggingMiddleware(
            LiteLLMUIProxy(strip_mount_path=True),
            strip_mount_path=True,
            mount_path=LITELLM_UI_MOUNT_PATH,
            logger=logger,
        ),
        name="litellm-ui-root",
        include_in_schema=False,
    )
    app.mount(
        LITELLM_UI_MOUNT_PATH,
        LiteLLMRequestLoggingMiddleware(LiteLLMUIProxy(), mount_path=LITELLM_UI_MOUNT_PATH, logger=logger),
        name="litellm-ui",
    )
    logger.info("LiteLLM UI proxy mounted at %s", LITELLM_UI_MOUNT_PATH)
