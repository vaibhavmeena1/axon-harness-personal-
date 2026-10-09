"""System One decisions reuse LiteLLM transport and preserve recommendation API behavior."""

import asyncio
import json
from collections.abc import Callable
from typing import Any

import httpx
import pytest
from fastapi import FastAPI, Request

from app.authentication import SessionRefreshResponseMiddleware, require_authenticated_user
from app.clients.auth_service import AuthData
from app.clients.litellm.decisions import LiteLLMDecisionClient, LiteLLMDecisionError
from app.clients.litellm.dependencies import get_litellm_decision_client
from app.clients.litellm.transport import LiteLLMTransport
from app.core.config import LiteLLMSettings
from app.routers.model_recommendations import router
from app.services.model_recommendation.catalog import get_model_catalog, model_policy_version
from app.services.model_recommendation.jev import build_jev_request, parse_jev_assessment
from app.services.model_recommendation.schemas import AvailableModel, ModelRecommendationRequest


@pytest.fixture
def settings() -> LiteLLMSettings:
    return LiteLLMSettings(
        upstream_url="http://litellm.test",
        upstream_root_path="/private",
        connect_timeout_seconds=10,
        pool_timeout_seconds=10,
        max_connections=10,
        max_keepalive_connections=5,
        keepalive_expiry_seconds=5,
        api_key="backend-only-key",
        decision_timeout_seconds=7,
    )


def assessment_response() -> dict[str, Any]:
    return {
        "model": "typesafe/jev-1.13",
        "answers": {
            "complexity": {"score": 3, "confidence": 1, "probabilities": {"0": 0, "1": 0, "2": 0, "3": 1}},
            "needs_deep_reasoning": {"noul": 0.98},
            "prioritizes_speed": {"noul": 0.02},
        },
    }


def recommendation_request() -> ModelRecommendationRequest:
    catalog = get_model_catalog()
    return ModelRecommendationRequest(
        prompt="private task content",
        currentModel=catalog.enabled_for_current_models[0],
        availableModels=[
            AvailableModel(provider=model.provider, id=model.id, input=model.input_modalities)
            for model in catalog.models
            if model.enabled
        ],
    )


def test_decisions_use_systemone_with_existing_payload_and_shared_pool(settings: LiteLLMSettings) -> None:
    seen: list[httpx.Request] = []
    payload = build_jev_request("private task content")

    def upstream(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=assessment_response())

    async def run() -> None:
        client = httpx.AsyncClient(transport=httpx.MockTransport(upstream))
        transport = LiteLLMTransport(settings, client=client)
        try:
            decisions = LiteLLMDecisionClient(settings, transport)
            result = await decisions.create_decision(payload)
            assert result == assessment_response()
            assert parse_jev_assessment(result).complexity == 3
            assert not client.is_closed
        finally:
            await transport.aclose()
        assert client.is_closed

    asyncio.run(run())
    assert len(seen) == 1
    assert str(seen[0].url) == "http://litellm.test/private/v1/systemone"
    assert seen[0].headers["authorization"] == "Bearer backend-only-key"
    assert seen[0].extensions["timeout"]["read"] == 7
    assert json.loads(seen[0].content) == payload
    assert "http-referer" not in seen[0].headers
    assert "x-openrouter-title" not in seen[0].headers


@pytest.mark.parametrize("status", [302, 400, 401, 403, 429, 500, 503])
def test_unsuccessful_decisions_do_not_follow_redirects_or_expose_content(
    settings: LiteLLMSettings, status: int
) -> None:
    seen: list[httpx.Request] = []

    def upstream(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(status, headers={"location": "http://evil.test"}, text="private task backend-only-key")

    async def run() -> None:
        client = httpx.AsyncClient(transport=httpx.MockTransport(upstream), follow_redirects=True)
        transport = LiteLLMTransport(settings, client=client)
        try:
            with pytest.raises(LiteLLMDecisionError, match=f"HTTP {status}") as error:
                await LiteLLMDecisionClient(settings, transport).create_decision(build_jev_request("private task"))
            assert "private task" not in str(error.value)
            assert "backend-only-key" not in str(error.value)
        finally:
            await transport.aclose()

    asyncio.run(run())
    assert len(seen) == 1
    assert seen[0].url.host == "litellm.test"


@pytest.mark.parametrize("body", [b"not JSON private task", b"null", b"[]", b'"private task"'])
def test_malformed_decisions_are_rejected(settings: LiteLLMSettings, body: bytes) -> None:
    async def run() -> None:
        client = httpx.AsyncClient(transport=httpx.MockTransport(lambda request: httpx.Response(200, content=body)))
        transport = LiteLLMTransport(settings, client=client)
        try:
            with pytest.raises(LiteLLMDecisionError) as error:
                await LiteLLMDecisionClient(settings, transport).create_decision(build_jev_request("private task"))
            assert "private task" not in str(error.value)
        finally:
            await transport.aclose()

    asyncio.run(run())


@pytest.mark.parametrize("error_type", [httpx.ReadTimeout, httpx.ConnectError, httpx.PoolTimeout])
def test_decision_transport_errors_are_sanitized(settings: LiteLLMSettings, error_type: type[httpx.HTTPError]) -> None:
    def upstream(request: httpx.Request) -> httpx.Response:
        raise error_type("private task backend-only-key", request=request)

    async def run() -> None:
        client = httpx.AsyncClient(transport=httpx.MockTransport(upstream))
        transport = LiteLLMTransport(settings, client=client)
        try:
            with pytest.raises(LiteLLMDecisionError, match="request failed") as error:
                await LiteLLMDecisionClient(settings, transport).create_decision(build_jev_request("private task"))
            assert "private task" not in str(error.value)
            assert error.value.__suppress_context__
        finally:
            await transport.aclose()

    asyncio.run(run())


def test_streaming_decisions_are_rejected_before_io(settings: LiteLLMSettings) -> None:
    def upstream(request: httpx.Request) -> httpx.Response:
        pytest.fail("Streaming must be rejected before issuing a request")

    async def run() -> None:
        client = httpx.AsyncClient(transport=httpx.MockTransport(upstream))
        transport = LiteLLMTransport(settings, client=client)
        try:
            with pytest.raises(ValueError, match="streaming"):
                await LiteLLMDecisionClient(settings, transport).create_decision({"stream": True})
        finally:
            await transport.aclose()

    asyncio.run(run())


def test_decision_dependency_returns_only_app_owned_client(settings: LiteLLMSettings) -> None:
    async def run() -> None:
        app = FastAPI()
        request = Request({"type": "http", "app": app, "headers": []})
        with pytest.raises(RuntimeError, match="not initialized"):
            get_litellm_decision_client(request)
        transport = LiteLLMTransport(settings)
        try:
            decisions = LiteLLMDecisionClient(settings, transport)
            app.state.litellm_decision_client = decisions
            assert get_litellm_decision_client(request) is decisions
        finally:
            await transport.aclose()

    asyncio.run(run())


async def call_recommender(
    settings: LiteLLMSettings,
    upstream: Callable[[httpx.Request], httpx.Response],
    payload: dict[str, Any],
    *,
    authenticated: bool = True,
) -> httpx.Response:
    app = FastAPI()
    app.include_router(router)
    app.add_middleware(SessionRefreshResponseMiddleware)
    if authenticated:

        async def authenticate(request: Request) -> AuthData:
            auth = AuthData(user_team_id=12, session_refresh_token="trusted-refresh")
            request.state.auth_data = auth
            return auth

        app.dependency_overrides[require_authenticated_user] = authenticate
    upstream_client = httpx.AsyncClient(transport=httpx.MockTransport(upstream))
    transport = LiteLLMTransport(settings, client=upstream_client)
    app.state.litellm_decision_client = LiteLLMDecisionClient(settings, transport)
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://backend.test") as client:
            return await client.post("/api/v1/model-recommendations", json=payload)
    finally:
        await transport.aclose()


def test_recommender_route_uses_litellm_and_preserves_response_contract(settings: LiteLLMSettings) -> None:
    seen: list[httpx.Request] = []

    def upstream(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=assessment_response())

    request = recommendation_request()
    response = asyncio.run(call_recommender(settings, upstream, request.model_dump(mode="json", by_alias=True)))
    assert response.status_code == 200
    result = response.json()
    assert result["requestId"] == str(request.request_id)
    assert result["policyVersion"] == model_policy_version()
    assert result["assessment"]["complexity"] == 3
    assert result["recommendations"][0]["id"] == "openai/gpt-5.6-sol"
    assert response.headers["x-session-refresh-token"] == "trusted-refresh"
    assert response.headers["cache-control"] == "no-store"
    assert "backend-only-key" not in response.text
    assert "private task content" not in response.text
    assert len(seen) == 1
    assert json.loads(seen[0].content) == build_jev_request(request.prompt)
    assert seen[0].headers["authorization"] == "Bearer backend-only-key"


@pytest.mark.parametrize("failure", ["http", "timeout", "json", "assessment"])
def test_recommender_failures_are_sanitized_502_and_preserve_session_rotation(
    settings: LiteLLMSettings, failure: str
) -> None:
    def upstream(request: httpx.Request) -> httpx.Response:
        if failure == "timeout":
            raise httpx.ReadTimeout("private task backend-only-key", request=request)
        if failure == "http":
            return httpx.Response(503, text="private task backend-only-key")
        if failure == "json":
            return httpx.Response(200, text="private task backend-only-key")
        return httpx.Response(200, json={"answers": {}})

    request = recommendation_request()
    response = asyncio.run(call_recommender(settings, upstream, request.model_dump(mode="json", by_alias=True)))
    assert response.status_code == 502
    assert response.json() == {"detail": "Model recommendation is temporarily unavailable"}
    assert response.headers["x-session-refresh-token"] == "trusted-refresh"
    assert response.headers["cache-control"] == "no-store"


@pytest.mark.parametrize("authenticated", [True, False])
def test_disabled_or_unauthenticated_recommendation_makes_no_decision_call(
    settings: LiteLLMSettings, authenticated: bool
) -> None:
    def upstream(request: httpx.Request) -> httpx.Response:
        pytest.fail("Disabled or unauthenticated recommendation must not call LiteLLM")

    payload = recommendation_request().model_dump(mode="json", by_alias=True)
    payload["currentModel"] = "not-enabled/model"
    response = asyncio.run(call_recommender(settings, upstream, payload, authenticated=authenticated))
    assert response.status_code == (204 if authenticated else 401)
