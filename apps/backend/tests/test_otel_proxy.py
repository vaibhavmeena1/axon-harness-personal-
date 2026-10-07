"""Real protobuf rewriting and bounded proxy behavior; no live collector required."""

import asyncio
import gzip
from dataclasses import replace
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI
from google.protobuf.message import Message
from opentelemetry.proto.collector.logs.v1.logs_service_pb2 import ExportLogsServiceRequest
from opentelemetry.proto.collector.metrics.v1.metrics_service_pb2 import ExportMetricsServiceRequest
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceRequest

from app import authentication
from app.clients.auth_service import AuthDataResponse, AuthServiceError
from app.core.cli_config import OtelProxySettings, parse_cli_telemetry, parse_otel_proxy
from app.proxies import otel


class AuthClient:
    def __init__(self, *, rich: bool = True, error: int | None = None) -> None:
        self.rich = rich
        self.error = error
        self.verifications = []

    async def get_auth_data(self, authorization: str, grace: dict) -> AuthDataResponse:
        if self.error:
            raise AuthServiceError("never-log-this-credential", self.error)
        data = {"user_team_id": 12, "session_refresh_token": "rotated-secret"}
        if self.rich:
            data.update(user_id=42, user_email="verified@example.com", user_name="Verified User")
        return AuthDataResponse(auth_data=data, response_headers={"Authorization": "must-not-forward"})

    async def verify_identity(self, authorization: str) -> dict:
        self.verifications.append(authorization)
        return {"status": "VERIFIED", "user_email": "verified@example.com", "user_name": "Verified User"}


def payload(signal: str) -> Message:
    if signal == "traces":
        result = ExportTraceServiceRequest()
        group = result.resource_spans.add()
        record = group.scope_spans.add().spans.add(name="test-span", trace_id=b"a" * 16, span_id=b"b" * 8)
        record.events.add(name="event").attributes.add(key="user.id").value.string_value = "spoofed-event"
        record.links.add(trace_id=b"c" * 16, span_id=b"d" * 8).attributes.add(
            key="user.email"
        ).value.string_value = "spoofed-link"
    elif signal == "metrics":
        result = ExportMetricsServiceRequest()
        group = result.resource_metrics.add()
        record = group.scope_metrics.add().metrics.add(name="pi.tokens.input").sum.data_points.add(as_int=10)
        record.exemplars.add().filtered_attributes.add(key="user.email").value.string_value = "spoofed-exemplar"
    else:
        result = ExportLogsServiceRequest()
        group = result.resource_logs.add()
        record = group.scope_logs.add().log_records.add()
        record.body.string_value = "session.started"
    for attributes in (group.resource.attributes, record.attributes):
        for key in ("user.id", "user.email", "user.name", "enduser.id", "pi.identity.source", "deputydev.user_team_id"):
            attributes.add(key=key).value.string_value = "spoofed"
        attributes.add(key="keep.me").value.string_value = "preserved"
    return result


def attributes(message: Message) -> list[dict[str, str]]:
    result = []
    for field, value in message.ListFields():
        if field.message_type is None:
            continue
        if field.is_repeated and field.name in {"attributes", "filtered_attributes"}:
            result.append({item.key: item.value.string_value for item in value})
        elif field.is_repeated:
            for child in value:
                result.extend(attributes(child))
        else:
            result.extend(attributes(value))
    return result


def setup(monkeypatch: pytest.MonkeyPatch, auth: AuthClient | None = None, **limits: int) -> tuple:
    auth = auth or AuthClient()
    monkeypatch.setattr(authentication, "get_auth_service_client", lambda _: auth)
    monkeypatch.setattr(otel, "get_auth_service_client", lambda _: auth)
    seen = []
    response = SimpleNamespace(status=200, headers={"content-type": "application/x-protobuf"}, body=b"")

    def collector(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(response.status, headers=response.headers, content=response.body)

    upstream = httpx.AsyncClient(transport=httpx.MockTransport(collector), follow_redirects=False)
    settings = OtelProxySettings("https://private-collector.test/otlp", {"Authorization": "Bearer collector-secret"})
    settings = replace(settings, **limits)
    app = FastAPI()
    app.state.otel_proxy = otel.OtelProxyRuntime(settings, upstream)
    app.include_router(otel.router)
    return app, upstream, seen, response


@pytest.mark.parametrize("signal", ["traces", "metrics", "logs"])
@pytest.mark.parametrize("compressed", [False, True])
def test_auth_identity_replaces_all_client_identity(
    monkeypatch: pytest.MonkeyPatch, signal: str, compressed: bool
) -> None:
    async def run() -> None:
        app, upstream, seen, _ = setup(monkeypatch)
        message = payload(signal)
        body = message.SerializeToString()
        headers = {
            "Authorization": "Bearer session-secret",
            "Content-Type": "application/x-protobuf",
            "Cookie": "private",
            "X-Auth-Context": "spoofed",
        }
        if compressed:
            body = gzip.compress(body)
            headers["Content-Encoding"] = "gzip"
        async with (
            upstream,
            httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="https://backend.test") as client,
        ):
            response = await client.post(
                f"/api/v1/otel/v1/{signal}?upstream=https://evil.test", content=body, headers=headers
            )
        assert response.status_code == 200
        assert response.headers["cache-control"] == "no-store"
        assert response.headers["x-session-refresh-token"] == "rotated-secret"
        assert len(seen) == 1
        request = seen[0]
        assert str(request.url) == f"https://private-collector.test/otlp/v1/{signal}"
        assert request.headers["authorization"] == "Bearer collector-secret"
        assert "cookie" not in request.headers and "x-auth-context" not in request.headers
        assert "content-encoding" not in request.headers
        message.ParseFromString(request.content)
        for group in attributes(message):
            assert group["user.id"] == "42"
            assert group["user.email"] == "verified@example.com"
            assert group["user.name"] == "Verified User"
            assert group["pi.identity.source"] == "deputydev_auth"
            assert group["deputydev.user_team_id"] == "12"
            assert "enduser.id" not in group
        assert b"spoofed" not in request.content
        assert b"preserved" in request.content

    asyncio.run(run())


def test_minimal_real_auth_contract_uses_verified_identity_and_rotated_token(monkeypatch: pytest.MonkeyPatch) -> None:
    async def run() -> None:
        auth = AuthClient(rich=False)
        app, upstream, seen, _ = setup(monkeypatch, auth)
        async with (
            upstream,
            httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="https://backend.test") as client,
        ):
            response = await client.post(
                "/api/v1/otel/v1/logs",
                content=payload("logs").SerializeToString(),
                headers={"Authorization": "Bearer session", "Content-Type": "application/x-protobuf"},
            )
        assert response.status_code == 200
        assert auth.verifications == ["Bearer rotated-secret"]
        assert b"verified@example.com" in seen[0].content

    asyncio.run(run())


@pytest.mark.parametrize("code", [401, 403, 503])
def test_auth_failure_never_forwards_or_leaks(monkeypatch: pytest.MonkeyPatch, code: int) -> None:
    async def run() -> None:
        app, upstream, seen, _ = setup(monkeypatch, AuthClient(error=code))
        async with (
            upstream,
            httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="https://backend.test") as client,
        ):
            response = await client.post(
                "/api/v1/otel/v1/logs", content=b"invalid", headers={"Authorization": "Bearer session"}
            )
        assert response.status_code == code
        assert response.headers["cache-control"] == "no-store"
        assert "credential" not in response.text
        assert not seen

    asyncio.run(run())


@pytest.mark.parametrize(
    "body,headers,expected",
    [
        (b"", {}, 401),
        (b"", {"Authorization": "Bearer x"}, 415),
        (b"bad", {"Authorization": "Bearer x", "Content-Type": "application/x-protobuf"}, 400),
        (
            b"bad",
            {"Authorization": "Bearer x", "Content-Type": "application/x-protobuf", "Content-Encoding": "gzip"},
            400,
        ),
        (b"", {"Authorization": "Bearer x", "Content-Type": "application/x-protobuf", "Content-Encoding": "br"}, 415),
    ],
)
def test_rejects_bad_requests(
    monkeypatch: pytest.MonkeyPatch, body: bytes, headers: dict[str, str], expected: int
) -> None:
    async def run() -> None:
        app, upstream, seen, _ = setup(monkeypatch)
        async with (
            upstream,
            httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="https://backend.test") as client,
        ):
            response = await client.post("/api/v1/otel/v1/logs", content=body, headers=headers)
        assert response.status_code == expected
        assert not seen

    asyncio.run(run())


def test_gzip_bomb_and_wire_size_are_bounded(monkeypatch: pytest.MonkeyPatch) -> None:
    async def run() -> None:
        app, upstream, seen, _ = setup(monkeypatch, max_body_bytes=100, max_decoded_body_bytes=1000)
        async with (
            upstream,
            httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="https://backend.test") as client,
        ):
            for body, encoding in [(b"x" * 101, "identity"), (gzip.compress(b"x" * 1001), "gzip")]:
                response = await client.post(
                    "/api/v1/otel/v1/logs",
                    content=body,
                    headers={
                        "Authorization": "Bearer x",
                        "Content-Type": "application/x-protobuf",
                        "Content-Encoding": encoding,
                    },
                )
                assert response.status_code == 413
        assert not seen

    asyncio.run(run())


@pytest.mark.parametrize("status,expected", [(200, 200), (429, 429), (503, 503), (302, 502)])
def test_preserves_collector_status_retry_and_protobuf_response(
    monkeypatch: pytest.MonkeyPatch, status: int, expected: int
) -> None:
    async def run() -> None:
        app, upstream, _, response = setup(monkeypatch)
        response.status = status
        response.headers.update({"retry-after": "2", "location": "https://evil.test"})
        response.body = b"\x0a\x00"
        async with (
            upstream,
            httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="https://backend.test") as client,
        ):
            result = await client.post(
                "/api/v1/otel/v1/logs",
                content=payload("logs").SerializeToString(),
                headers={"Authorization": "Bearer x", "Content-Type": "application/x-protobuf"},
            )
        assert result.status_code == expected
        assert "location" not in result.headers
        if status != 302:
            assert result.content == b"\x0a\x00"
            assert result.headers["retry-after"] == "2"

    asyncio.run(run())


def test_rate_concurrency_disabled_and_exact_routes(monkeypatch: pytest.MonkeyPatch) -> None:
    async def run() -> None:
        app, upstream, seen, _ = setup(monkeypatch, rate_limit_per_minute=1)
        headers = {"Authorization": "Bearer x", "Content-Type": "application/x-protobuf"}
        async with (
            upstream,
            httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="https://backend.test") as client,
        ):
            assert (await client.post("/api/v1/otel/v1/logs", content=b"", headers=headers)).status_code == 200
            assert (await client.post("/api/v1/otel/v1/logs", content=b"", headers=headers)).status_code == 429
            app.state.otel_proxy.active = 20
            assert (await client.post("/api/v1/otel/v1/logs", content=b"", headers=headers)).status_code == 429
            app.state.otel_proxy = None
            assert (await client.post("/api/v1/otel/v1/logs", content=b"", headers=headers)).status_code == 503
            assert (await client.get("/api/v1/otel/v1/logs")).status_code == 405
            assert (await client.post("/api/v1/otel/v1/anything")).status_code == 404
        assert len(seen) == 1

    asyncio.run(run())


def test_identity_added_when_resource_is_absent_and_name_removed_when_unknown() -> None:
    message = ExportTraceServiceRequest()
    span = message.resource_spans.add().scope_spans.add().spans.add(name="span")
    span.attributes.add(key="user.name").value.string_value = "fake"
    otel.rewrite_identity(
        message, {"user.id": "42", "user.email": "auth@example.com", "pi.identity.source": "deputydev_auth"}
    )
    assert message.resource_spans[0].HasField("resource")
    for group in attributes(message):
        assert group["user.id"] == "42"
        assert "user.name" not in group


@pytest.mark.parametrize(
    "patch",
    [
        {"UPSTREAM_URL": "https://user:secret@collector.test"},
        {"UPSTREAM_URL": "https://collector.test?secret=x"},
        {"MAX_BODY_BYTES": True},
        {"MAX_CONCURRENT_REQUESTS": 0},
        {"HEADERS": {"Host": "evil.test"}},
        {"HEADERS": {"Authorization": "Bearer secret\r\nX-Inject: x"}},
    ],
)
def test_invalid_private_proxy_config(patch: dict) -> None:
    raw = {
        "CLI_CLIENT_CONFIG": {
            "ALLOWED_TELEMETRY_ORIGINS": ["https://collector.test"],
            "PROXY": {"ENABLED": True, "UPSTREAM_URL": "https://collector.test", **patch},
        }
    }
    with pytest.raises(ValueError):
        parse_otel_proxy(raw)


@pytest.mark.parametrize("custom_ca", [False, True])
def test_proxy_honors_ca_trust_without_enabling_environment_proxies(
    monkeypatch: pytest.MonkeyPatch, custom_ca: bool
) -> None:
    settings = OtelProxySettings(upstream_url="https://collector.test", headers={})
    monkeypatch.setattr(otel, "get_settings", lambda: SimpleNamespace(otel_proxy=settings))
    monkeypatch.delenv("SSL_CERT_FILE", raising=False)
    monkeypatch.delenv("SSL_CERT_DIR", raising=False)
    if custom_ca:
        monkeypatch.setenv("SSL_CERT_FILE", "/operator/ca.pem")
        monkeypatch.setenv("SSL_CERT_DIR", "/operator/certs")
    context = object()
    ca_calls = []
    client_calls = []

    def create_context(**kwargs: object) -> object:
        ca_calls.append(kwargs)
        return context

    def create_client(**kwargs: object) -> SimpleNamespace:
        client_calls.append(kwargs)
        return SimpleNamespace()

    monkeypatch.setattr(otel.ssl, "create_default_context", create_context)
    monkeypatch.setattr(otel.httpx, "AsyncClient", create_client)
    app = FastAPI()
    asyncio.run(otel.initialize_otel_proxy(app))
    assert ca_calls == ([{"cafile": "/operator/ca.pem", "capath": "/operator/certs"}] if custom_ca else [])
    assert client_calls[0]["verify"] is (context if custom_ca else True)
    assert client_calls[0]["trust_env"] is False
    assert client_calls[0]["follow_redirects"] is False


def test_managed_policy_requires_proxy_and_cannot_select_external_destination() -> None:
    raw = {"CLI_CLIENT_CONFIG": {"TELEMETRY": {"ENABLED": True}}}
    with pytest.raises(ValueError):
        parse_cli_telemetry(raw)
    raw["CLI_CLIENT_CONFIG"]["TELEMETRY"] = {"ENABLED": False}
    assert parse_cli_telemetry(raw).enabled is False
