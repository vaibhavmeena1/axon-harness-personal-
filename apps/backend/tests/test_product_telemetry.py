"""Product stats use controlled metadata and never serialize prompts/errors into OTel."""

import asyncio
from typing import Any
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI, Request
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import InMemoryMetricReader
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import StatusCode

from app.clients.auth_service import AuthData
from app.clients.litellm.identity import LiteLLMIdentityClient
from app.core.config import ModelRecommenderSettings
from app.services.model_recommendation.catalog import get_model_catalog, model_policy_version
from app.services.model_recommendation.schemas import (
    AvailableModel,
    ModelRecommendationRequest,
    ModelRecommendationResponse,
)
from app.services.model_recommendation.service import ModelRecommendationError, ModelRecommendationService
from app.telemetry import ProductTelemetry, parse_backend_telemetry, verified_telemetry_identity
from tests.test_litellm_decisions import verified_user


def test_backend_otel_http_configuration_and_private_headers() -> None:
    assert parse_backend_telemetry({}) is None
    assert parse_backend_telemetry({"OPEN_TELEMETRY": {"ENABLED": False}}) is None
    raw = {
        "NAME": "backend",
        "OPEN_TELEMETRY": {
            "ENABLED": True,
            "ENDPOINT": "http://collector.monitoring.svc.cluster.local:4318",
            "HEADERS": {"Authorization": "Bearer private"},
        },
    }
    settings = parse_backend_telemetry(raw)
    assert settings.endpoint.endswith(":4318")
    assert settings.service_name == "backend"
    assert "private" not in repr(settings)
    for value in ("grpc", "http/json"):
        with pytest.raises(ValueError):
            parse_backend_telemetry({**raw, "OPEN_TELEMETRY": {**raw["OPEN_TELEMETRY"], "PROTOCOL": value}})
    for rate in (-1, 2, float("nan"), True):
        with pytest.raises(ValueError):
            parse_backend_telemetry({**raw, "OPEN_TELEMETRY": {**raw["OPEN_TELEMETRY"], "SAMPLING_RATE": rate}})


@pytest.mark.parametrize("invalid", [False, True])
def test_recommender_assessment_ranking_metrics_and_traces_are_content_free(invalid: bool) -> None:
    class Decisions:
        async def create_decision(self, request: dict[str, Any], *, api_key: str) -> dict[str, Any]:
            assert api_key == "caller-virtual-key"
            assert request["state"]["task"] == "secret prompt"
            return (
                {}
                if invalid
                else {
                    "answers": {
                        "complexity": {"score": 2.5, "confidence": 0.9},
                        "needs_deep_reasoning": {"noul": 0.8},
                        "prioritizes_speed": {"noul": 0.1},
                    }
                }
            )

    exporter = InMemorySpanExporter()
    traces = TracerProvider()
    traces.add_span_processor(SimpleSpanProcessor(exporter))
    reader = InMemoryMetricReader()
    metrics = MeterProvider(metric_readers=[reader])
    telemetry = ProductTelemetry(traces.get_tracer("test"), metrics.get_meter("test"))
    request = ModelRecommendationRequest(
        prompt="secret prompt",
        availableModels=[
            AvailableModel(
                provider=model.provider, id=model.id, reasoning=model.reasoning > 0, input=model.input_modalities
            )
            for model in get_model_catalog().models
            if model.enabled
        ],
    )
    identity = {"user.email": "verified@example.com", "user.id": "42"}

    identity_client = AsyncMock(spec=LiteLLMIdentityClient)
    identity_client.ensure_identity.return_value = "caller-virtual-key"

    async def run() -> ModelRecommendationResponse:
        with telemetry.operation("request", identity, **{"axon.recommendation.id": str(request.request_id)}):
            return await ModelRecommendationService(Decisions(), identity_client, ModelRecommenderSettings()).recommend(
                request, telemetry, identity, user=verified_user()
            )

    if invalid:
        with pytest.raises(ModelRecommendationError):
            asyncio.run(run())
    else:
        response = asyncio.run(run())
        assert response.request_id == request.request_id
        assert response.policy_version == model_policy_version()
        assert response.assessment.complexity == 2.5
        assert response.recommendations
    identity_client.ensure_identity.assert_awaited_once_with(verified_user())
    identity_client.authenticated_key.assert_not_awaited()
    spans = exporter.get_finished_spans()
    assert not any(event.name == "exception" for span in spans for event in span.events)
    assert "secret prompt" not in repr(spans)
    if invalid:
        assert spans[-1].status.status_code == StatusCode.ERROR
    observed = reader.get_metrics_data()
    points = [
        point
        for resource in observed.resource_metrics
        for scope in resource.scope_metrics
        for metric in scope.metrics
        for point in metric.data.data_points
    ]
    assert points
    assert all(point.attributes["user.email"] == "verified@example.com" for point in points)
    assert all("axon.recommendation.id" not in point.attributes for point in points)
    assert all("secret prompt" not in repr(point.attributes) for point in points)
    traces.shutdown()
    metrics.shutdown()


def identity_request(auth: AuthData, enabled: bool = True) -> Request:
    app = FastAPI()
    if enabled:
        app.state.product_telemetry = object()
    request = Request({"type": "http", "app": app, "headers": [(b"authorization", b"Bearer original")]})
    request.state.auth_data = auth
    return request


def test_product_identity_reuses_auth_and_never_attributes_client_supplied_headers(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def unexpected_lookup(request: Request) -> None:
        raise AssertionError("identity lookup must not run")

    monkeypatch.setattr("app.clients.auth_service.get_auth_service_client", unexpected_lookup)
    auth = AuthData(user_team_id=12, user_id=42, user_email=" verified@example.com ")
    assert asyncio.run(verified_telemetry_identity(identity_request(auth))) == {
        "axon.user_team_id": "12",
        "user.id": "42",
        "user.email": "verified@example.com",
    }
    assert asyncio.run(verified_telemetry_identity(identity_request(AuthData(user_team_id=12), enabled=False))) == {
        "axon.user_team_id": "12"
    }


@pytest.mark.parametrize("email", ["verified@example.com", "invalid", "bad\x7f@example.com", "bad\n@example.com"])
def test_product_identity_uses_latest_rotation_and_validates_email(email: str, monkeypatch: pytest.MonkeyPatch) -> None:
    seen = []

    class Client:
        async def verify_identity(self, authorization: str) -> dict[str, str]:
            seen.append(authorization)
            return {"status": "EXPIRED", "user_email": email, "encrypted_session_data": "newest-rotation"}

    monkeypatch.setattr("app.clients.auth_service.get_auth_service_client", lambda request: Client())
    auth = AuthData(user_team_id=12, session_refresh_token="first-rotation")
    identity = asyncio.run(verified_telemetry_identity(identity_request(auth)))
    assert seen == ["Bearer first-rotation"]
    assert auth.session_refresh_token == "newest-rotation"
    assert identity.get("user.email") == (email if email == "verified@example.com" else None)
    assert identity.get("user.id") == (email if email == "verified@example.com" else None)
    assert "rotation" not in repr(identity)


def test_product_identity_failure_is_best_effort(monkeypatch: pytest.MonkeyPatch) -> None:
    class Client:
        async def verify_identity(self, authorization: str) -> dict[str, str]:
            raise RuntimeError("private auth details")

    monkeypatch.setattr("app.clients.auth_service.get_auth_service_client", lambda request: Client())
    auth = AuthData(user_team_id=12, user_id=42, session_refresh_token="saved")
    assert asyncio.run(verified_telemetry_identity(identity_request(auth))) == {
        "axon.user_team_id": "12",
        "user.id": "42",
    }
    assert auth.session_refresh_token == "saved"
