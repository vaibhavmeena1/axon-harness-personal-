"""Bounded, authenticated OTLP/HTTP ingestion with server-authoritative identity."""

import asyncio
import logging
import os
import ssl
import time
import zlib
from dataclasses import dataclass

import httpx
from fastapi import APIRouter, FastAPI, HTTPException, Request, Response
from google.protobuf.message import DecodeError, Message
from opentelemetry.proto.collector.logs.v1.logs_service_pb2 import ExportLogsServiceRequest
from opentelemetry.proto.collector.metrics.v1.metrics_service_pb2 import ExportMetricsServiceRequest
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceRequest
from starlette.requests import ClientDisconnect

from app.authentication import authenticate_request
from app.clients.auth_service import AuthServiceError, get_auth_service_client
from app.core.cli_config import OTEL_PROXY_PATH, OtelProxySettings
from app.core.config import get_settings

router = APIRouter(prefix=OTEL_PROXY_PATH, tags=["otel"])
_MESSAGES = {
    "traces": ExportTraceServiceRequest,
    "metrics": ExportMetricsServiceRequest,
    "logs": ExportLogsServiceRequest,
}
_NO_STORE = {"Cache-Control": "no-store"}
logger = logging.getLogger(__name__)


def _error(code: int, message: str, *, headers: dict[str, str] | None = None) -> HTTPException:
    return HTTPException(code, message, headers={**_NO_STORE, **(headers or {})})


def _identity_text(value: object, maximum: int) -> str | None:
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        return None
    if any(ord(char) < 32 or ord(char) == 127 for char in value):
        return None
    return value.strip()


async def authenticated_attributes(request: Request) -> dict[str, str]:
    """Require subscription auth, then obtain identity from that same verified session."""
    auth_data = await authenticate_request(request)
    data = auth_data.model_dump()
    email = _identity_text(data.get("user_email"), 320)
    name = _identity_text(data.get("user_name"), 256)
    if email is None:
        refreshed = auth_data.session_refresh_token
        authorization = f"Bearer {refreshed}" if refreshed else request.headers["authorization"]
        verified = await get_auth_service_client(request).verify_identity(authorization)
        email = _identity_text(verified.get("user_email"), 320)
        name = _identity_text(verified.get("user_name"), 256)
        if verified.get("status") == "EXPIRED":
            refreshed = _identity_text(verified.get("encrypted_session_data"), 16384)
            if refreshed is None:
                raise AuthServiceError("Identity verification returned no refreshed session")
            request.state.auth_response_headers["x-session-refresh-token"] = refreshed
            # The response middleware must preserve this newest auth-issued rotation.
            auth_data.session_refresh_token = refreshed
    if email is None or "@" not in email:
        raise AuthServiceError("Auth service returned incomplete telemetry identity")
    if auth_data.session_refresh_token and "x-session-refresh-token" not in request.state.auth_response_headers:
        request.state.auth_response_headers["x-session-refresh-token"] = auth_data.session_refresh_token
    user_id = data.get("user_id")
    attributes = {
        "user.id": str(user_id)
        if isinstance(user_id, int) and not isinstance(user_id, bool) and user_id > 0
        else email,
        "user.email": email,
        "pi.identity.source": "axon_auth",
        "axon.user_team_id": str(auth_data.user_team_id),
    }
    if name:
        attributes["user.name"] = name
    return attributes


def _is_identity(key: str) -> bool:
    key = key.lower()
    return key.startswith(("user.", "enduser.")) or key in {"pi.identity.source", "axon.user_team_id"}


def rewrite_identity(message: Message, identity: dict[str, str]) -> None:
    """Replace resource AND record/datapoint identities; preserve non-identity telemetry."""
    # Some clients omit Resource entirely. Ensure every batch gets an attributed resource.
    for field, resources in message.ListFields():
        if field.name.startswith("resource_"):
            for group in resources:
                group.resource.SetInParent()

    _visit_attributes(message, identity, [10000])


def _visit_attributes(node: Message, identity: dict[str, str], budget: list[int]) -> None:
    budget[0] -= 1
    if budget[0] < 0:
        raise _error(413, "Telemetry batch has too many records")
    for field in node.DESCRIPTOR.fields:
        if field.message_type is None:
            continue
        value = getattr(node, field.name)
        if field.is_repeated:
            if field.name in {"attributes", "filtered_attributes"} and field.message_type.full_name.endswith(
                ".KeyValue"
            ):
                kept = [item for item in value if not _is_identity(item.key)]
                del value[:]
                value.extend(kept)
                for key, text in identity.items():
                    value.add(key=key).value.string_value = text
            else:
                for child in value:
                    _visit_attributes(child, identity, budget)
        elif node.HasField(field.name):
            _visit_attributes(value, identity, budget)


@dataclass
class OtelProxyRuntime:
    settings: OtelProxySettings
    client: httpx.AsyncClient
    active: int = 0

    def __post_init__(self) -> None:
        # Limits are per worker; deployment ingress should also enforce global quotas.
        self.windows: dict[str, tuple[float, int]] = {}

    def admit(self, user: str) -> bool:
        now = time.monotonic()
        if len(self.windows) >= 4096:
            self.windows = {key: value for key, value in self.windows.items() if now - value[0] < 60}
        start, count = self.windows.get(user, (now, 0))
        if now - start >= 60:
            start, count = now, 0
        if count >= self.settings.rate_limit_per_minute or (user not in self.windows and len(self.windows) >= 4096):
            return False
        self.windows[user] = (start, count + 1)
        return True


async def initialize_otel_proxy(app: FastAPI) -> None:
    settings = get_settings().otel_proxy
    if settings is not None:
        # Honor operator CA trust without enabling ambient proxies or other HTTPX env settings.
        cafile = os.environ.get("SSL_CERT_FILE") or None
        capath = os.environ.get("SSL_CERT_DIR") or None
        verify = ssl.create_default_context(cafile=cafile, capath=capath) if cafile or capath else True
        client = httpx.AsyncClient(
            verify=verify,
            timeout=httpx.Timeout(settings.request_timeout_seconds, connect=settings.connect_timeout_seconds),
            limits=httpx.Limits(max_connections=settings.max_concurrent_requests),
            follow_redirects=False,
            trust_env=False,
        )
        app.state.otel_proxy = OtelProxyRuntime(settings, client)


async def close_otel_proxy(app: FastAPI) -> None:
    runtime = getattr(app.state, "otel_proxy", None)
    if runtime is not None:
        await runtime.client.aclose()
        app.state.otel_proxy = None


async def _read_body(request: Request, maximum: int) -> bytes:
    declared = request.headers.get("content-length")
    if declared is not None:
        try:
            length = int(declared)
        except ValueError:
            raise _error(400, "Invalid content length") from None
        if length < 0 or length > maximum:
            raise _error(413, "Telemetry payload too large")
    chunks = bytearray()
    async for chunk in request.stream():
        if len(chunks) + len(chunk) > maximum:
            raise _error(413, "Telemetry payload too large")
        chunks.extend(chunk)
    return bytes(chunks)


def _decode_body(body: bytes, encoding: str, maximum: int) -> bytes:
    if encoding == "gzip":
        try:
            decoder = zlib.decompressobj(16 + zlib.MAX_WBITS)
            body = decoder.decompress(body, maximum + 1)
            if len(body) > maximum or decoder.unconsumed_tail:
                raise _error(413, "Telemetry payload too large")
            if not decoder.eof or decoder.unused_data:
                raise _error(400, "Invalid telemetry compression")
        except zlib.error:
            raise _error(400, "Invalid telemetry compression") from None
    if len(body) > maximum:
        raise _error(413, "Telemetry payload too large")
    return body


async def _attributed_payload(
    request: Request, settings: OtelProxySettings, signal: str, identity: dict[str, str]
) -> bytes:
    content_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if content_type != "application/x-protobuf":
        raise _error(415, "Expected OTLP protobuf")
    encoding = request.headers.get("content-encoding", "identity").lower().strip()
    if encoding not in {"identity", "gzip"}:
        raise _error(415, "Unsupported telemetry compression")
    try:
        async with asyncio.timeout(settings.request_timeout_seconds):
            body = await _read_body(request, settings.max_body_bytes)
    except TimeoutError:
        raise _error(408, "Telemetry upload timed out") from None
    message = _MESSAGES[signal]()
    try:
        message.ParseFromString(_decode_body(body, encoding, settings.max_decoded_body_bytes))
    except DecodeError:
        raise _error(400, "Invalid OTLP payload") from None
    rewrite_identity(message, identity)
    body = message.SerializeToString()
    if len(body) > settings.max_decoded_body_bytes:
        raise _error(413, "Attributed telemetry payload too large")
    return body


async def _collector_response(upstream: httpx.Response, headers: dict[str, str]) -> Response:
    if upstream.headers.get("content-encoding", "identity").lower().strip() != "identity":
        raise _error(502, "Unsupported collector response encoding")
    response_body = bytearray()
    async for chunk in upstream.aiter_bytes():
        if len(response_body) + len(chunk) > 65536:
            raise _error(502, "Collector response too large")
        response_body.extend(chunk)
    if 300 <= upstream.status_code < 400:
        raise _error(502, "Collector redirect refused")
    for name in ("content-type", "retry-after"):
        if name in upstream.headers:
            headers[name] = upstream.headers[name]
    return Response(bytes(response_body), status_code=upstream.status_code, headers=headers)


async def _forward(runtime: OtelProxyRuntime, signal: str, body: bytes, headers: dict[str, str]) -> Response:
    try:
        async with asyncio.timeout(runtime.settings.request_timeout_seconds):
            # Never forward caller headers/query parameters or follow collector redirects.
            async with runtime.client.stream(
                "POST",
                f"{runtime.settings.upstream_url}/v1/{signal}",
                content=body,
                headers={
                    **runtime.settings.headers,
                    "Content-Type": "application/x-protobuf",
                    "Accept-Encoding": "identity",
                },
            ) as upstream:
                return await _collector_response(upstream, headers)
    except (httpx.HTTPError, TimeoutError):
        raise _error(503, "Telemetry collector is unavailable") from None


async def ingest(request: Request, signal: str) -> Response:
    runtime: OtelProxyRuntime | None = getattr(request.app.state, "otel_proxy", None)
    if runtime is None:
        raise _error(503, "Telemetry proxy is unavailable")
    if runtime.active >= runtime.settings.max_concurrent_requests:
        raise _error(429, "Telemetry proxy is busy", headers={"Retry-After": "1"})
    runtime.active += 1
    headers = {**_NO_STORE}
    try:
        try:
            identity = await authenticated_attributes(request)
        except AuthServiceError as exc:
            detail = {401: "Authentication required", 403: "Access denied"}.get(
                exc.status_code, "Auth service is unavailable"
            )
            raise _error(exc.status_code, detail) from None
        refresh = request.state.auth_response_headers.get("x-session-refresh-token")
        if _identity_text(refresh, 16384) and str(refresh).isascii():
            headers["x-session-refresh-token"] = refresh
        if not runtime.admit(identity["axon.user_team_id"]):
            raise _error(429, "Telemetry rate limit exceeded", headers={"Retry-After": "60"})
        body = await _attributed_payload(request, runtime.settings, signal, identity)
        return await _forward(runtime, signal, body, headers)
    except ClientDisconnect:
        # No complete batch exists to attribute/forward. The client is already gone;
        # return the conventional cancellation status and release capacity normally.
        logger.info("Telemetry upload cancelled signal=%s reason=client_disconnected", signal)
        return Response(status_code=499, headers=headers)
    except HTTPException as exc:
        exc.headers = {**headers, **(exc.headers or {})}
        raise
    finally:
        runtime.active -= 1


@router.post("/v1/traces")
async def traces(request: Request) -> Response:
    return await ingest(request, "traces")


@router.post("/v1/metrics")
async def metrics(request: Request) -> Response:
    return await ingest(request, "metrics")


@router.post("/v1/logs")
async def logs(request: Request) -> Response:
    return await ingest(request, "logs")
