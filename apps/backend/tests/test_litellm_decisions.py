"""System One decisions reuse LiteLLM transport and preserve recommendation API behavior."""

import asyncio
import json
from collections.abc import Callable
from dataclasses import replace
from typing import Any

import httpx
import pytest
from fastapi import FastAPI, Request

from app.authentication import SessionRefreshResponseMiddleware, require_authenticated_user
from app.clients.auth_service import AuthData, AuthenticatedUser
from app.clients.litellm.decisions import LiteLLMDecisionClient, LiteLLMDecisionError
from app.clients.litellm.dependencies import get_litellm_decision_client
from app.clients.litellm.identity import LiteLLMIdentityClient
from app.clients.litellm.transport import LiteLLMTransport
from app.core.config import LiteLLMSettings
from app.routers.model_recommendations import router
from app.services.model_recommendation.catalog import get_model_catalog, model_policy_version
from app.services.model_recommendation.jev import build_jev_request, parse_jev_assessment
from app.services.model_recommendation.schemas import AvailableModel, ModelRecommendationRequest
from tests.test_litellm_identity import IdentityAPI


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
        team_id="existing-team-id",
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


def test_decisions_use_systemone_with_existing_payload_and_buffered_pool(settings: LiteLLMSettings) -> None:
    seen: list[httpx.Request] = []
    payload = build_jev_request("private task content")

    def upstream(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=assessment_response())

    async def run() -> None:
        client = httpx.AsyncClient(transport=httpx.MockTransport(upstream))
        transport = LiteLLMTransport(settings, client=client, management_client=client)
        try:
            decisions = LiteLLMDecisionClient(settings, transport)
            result = await decisions.create_decision(payload, api_key="caller-virtual-key")
            assert result == assessment_response()
            assert parse_jev_assessment(result).complexity == 3
            assert not client.is_closed
        finally:
            await transport.aclose()
        assert client.is_closed

    asyncio.run(run())
    assert len(seen) == 1
    assert str(seen[0].url) == "http://litellm.test/private/v1/systemone"
    assert seen[0].headers["authorization"] == "Bearer caller-virtual-key"
    assert seen[0].extensions["timeout"]["read"] == 7
    assert json.loads(seen[0].content) == payload
    assert "http-referer" not in seen[0].headers
    assert "x-openrouter-title" not in seen[0].headers


@pytest.mark.parametrize("api_key", ["", "backend-only-key"])
def test_decisions_reject_missing_or_admin_key_before_io(settings: LiteLLMSettings, api_key: str) -> None:
    def upstream(request: httpx.Request) -> httpx.Response:
        pytest.fail("Missing or admin credentials must never be used for inference")

    async def run() -> None:
        client = httpx.AsyncClient(transport=httpx.MockTransport(upstream))
        transport = LiteLLMTransport(settings, client=client, management_client=client)
        try:
            with pytest.raises(LiteLLMDecisionError, match="caller-specific"):
                await LiteLLMDecisionClient(settings, transport).create_decision(
                    build_jev_request("private task"), api_key=api_key
                )
        finally:
            await transport.aclose()

    asyncio.run(run())


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
        transport = LiteLLMTransport(settings, client=client, management_client=client)
        try:
            with pytest.raises(LiteLLMDecisionError, match=f"HTTP {status}") as error:
                await LiteLLMDecisionClient(settings, transport).create_decision(
                    build_jev_request("private task"), api_key="caller-virtual-key"
                )
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
        transport = LiteLLMTransport(settings, client=client, management_client=client)
        try:
            with pytest.raises(LiteLLMDecisionError) as error:
                await LiteLLMDecisionClient(settings, transport).create_decision(
                    build_jev_request("private task"), api_key="caller-virtual-key"
                )
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
        transport = LiteLLMTransport(settings, client=client, management_client=client)
        try:
            with pytest.raises(LiteLLMDecisionError, match="request failed") as error:
                await LiteLLMDecisionClient(settings, transport).create_decision(
                    build_jev_request("private task"), api_key="caller-virtual-key"
                )
            assert "private task" not in str(error.value)
            assert error.value.__suppress_context__
        finally:
            await transport.aclose()

    asyncio.run(run())


@pytest.mark.parametrize("status", [401, 403])
def test_denied_decisions_log_the_route_without_content(
    settings: LiteLLMSettings, status: int, caplog: pytest.LogCaptureFixture
) -> None:
    async def run() -> None:
        client = httpx.AsyncClient(
            transport=httpx.MockTransport(lambda request: httpx.Response(status, text="private task"))
        )
        transport = LiteLLMTransport(settings, client=client, management_client=client)
        try:
            with pytest.raises(LiteLLMDecisionError):
                await LiteLLMDecisionClient(settings, transport).create_decision(
                    build_jev_request("private task"), api_key="caller-virtual-key"
                )
        finally:
            await transport.aclose()

    with caplog.at_level("WARNING", logger="app.clients.litellm.decisions"):
        asyncio.run(run())
    assert f"HTTP {status}" in caplog.text
    assert "/v1/systemone" in caplog.text
    assert "private task" not in caplog.text
    assert "caller-virtual-key" not in caplog.text


def test_decisions_beyond_capacity_fail_fast_and_release_slots(settings: LiteLLMSettings) -> None:
    limited = replace(settings, decision_max_concurrency=1)
    started = asyncio.Event()
    release = asyncio.Event()
    calls = 0

    async def upstream(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if calls == 1:
            started.set()
            await release.wait()
        return httpx.Response(200, json=assessment_response())

    async def run() -> None:
        client = httpx.AsyncClient(transport=httpx.MockTransport(upstream))
        transport = LiteLLMTransport(limited, client=client, management_client=client)
        decisions = LiteLLMDecisionClient(limited, transport)
        try:
            first = asyncio.create_task(
                decisions.create_decision(build_jev_request("first"), api_key="caller-virtual-key")
            )
            await started.wait()
            with pytest.raises(LiteLLMDecisionError, match="capacity is exhausted"):
                await decisions.create_decision(build_jev_request("second"), api_key="caller-virtual-key")
            release.set()
            assert await first == assessment_response()
            # The slot is released after completion, including for later callers.
            assert (
                await decisions.create_decision(build_jev_request("third"), api_key="caller-virtual-key")
                == assessment_response()
            )
        finally:
            await transport.aclose()

    asyncio.run(run())
    assert calls == 2


def test_streaming_decisions_are_rejected_before_io(settings: LiteLLMSettings) -> None:
    def upstream(request: httpx.Request) -> httpx.Response:
        pytest.fail("Streaming must be rejected before issuing a request")

    async def run() -> None:
        client = httpx.AsyncClient(transport=httpx.MockTransport(upstream))
        transport = LiteLLMTransport(settings, client=client, management_client=client)
        try:
            with pytest.raises(ValueError, match="streaming"):
                await LiteLLMDecisionClient(settings, transport).create_decision(
                    {"stream": True}, api_key="caller-virtual-key"
                )
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


def verified_user(user_team_id: int = 12) -> AuthenticatedUser:
    return AuthenticatedUser(
        user_team_id=user_team_id,
        team_id=7,
        user_email=f"dev{user_team_id}@example.com",
        organization_name="Dev",
        role="member",
        session_refresh_token="trusted-refresh",
    )


async def call_recommender(
    settings: LiteLLMSettings,
    upstream: Callable[[httpx.Request], httpx.Response],
    payload: dict[str, Any],
    *,
    authenticated: bool = True,
    auth_data: AuthData | None = None,
    management: Callable[[httpx.Request], httpx.Response] | None = None,
) -> httpx.Response:
    app = FastAPI()
    app.include_router(router)
    app.add_middleware(SessionRefreshResponseMiddleware)
    if authenticated:

        async def authenticate(request: Request) -> AuthData:
            auth = auth_data if auth_data is not None else verified_user()
            request.state.auth_data = auth
            return auth

        app.dependency_overrides[require_authenticated_user] = authenticate
    management = management or IdentityAPI()

    def dispatch(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/private/v1/systemone":
            return upstream(request)
        # Reuse the stock-management API double with the configured root path.
        return management(
            httpx.Request(
                request.method,
                request.url.copy_with(path=request.url.path.removeprefix("/private")),
                headers=request.headers,
                content=request.content,
            )
        )

    upstream_client = httpx.AsyncClient(transport=httpx.MockTransport(dispatch))
    transport = LiteLLMTransport(settings, client=upstream_client, management_client=upstream_client)
    app.state.litellm_decision_client = LiteLLMDecisionClient(settings, transport)
    app.state.litellm_identity_client = LiteLLMIdentityClient(settings, transport)
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://backend.test") as client:
            return await client.post("/api/v1/model-recommendations", json=payload)
    finally:
        await transport.aclose()


@pytest.mark.parametrize("identity_sync_enabled", [True, False])
def test_recommender_route_uses_litellm_and_preserves_response_contract(
    settings: LiteLLMSettings, identity_sync_enabled: bool
) -> None:
    settings = replace(settings, identity_sync_enabled=identity_sync_enabled)
    seen: list[httpx.Request] = []

    def upstream(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=assessment_response())

    request = recommendation_request()
    management = IdentityAPI()
    response = asyncio.run(
        call_recommender(settings, upstream, request.model_dump(mode="json", by_alias=True), management=management)
    )
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
    generated = management.posted("/key/generate")[0]
    assert generated["user_id"] != "12"
    assert management.users[generated["user_id"]]["user_email"] == "dev12@example.com"
    assert generated["team_id"] == settings.team_id
    assert "/v1/systemone" in generated["allowed_routes"]
    assert seen[0].headers["authorization"] == f"Bearer {generated['key']}"
    assert seen[0].headers["authorization"] != f"Bearer {settings.api_key}"
    assert generated["key"] not in response.text
    assert all(req.headers["authorization"] == f"Bearer {settings.api_key}" for req in management.requests)


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


@pytest.mark.parametrize("user_team_id", [12, 99])
def test_recommendations_use_only_verified_caller_identity(settings: LiteLLMSettings, user_team_id: int) -> None:
    seen: list[httpx.Request] = []

    def upstream(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=assessment_response())

    payload = recommendation_request().model_dump(mode="json", by_alias=True)
    payload.update(user_team_id=999, team_id=999, user_email="attacker@example.com", api_key="attacker-key")
    api = IdentityAPI()
    response = asyncio.run(
        call_recommender(settings, upstream, payload, auth_data=verified_user(user_team_id), management=api)
    )
    assert response.status_code == 200
    generated = api.posted("/key/generate")[0]
    assert generated["user_id"] != str(user_team_id)
    assert generated["metadata"]["deputydev-user-team-id"] == str(user_team_id)
    assert api.users[generated["user_id"]]["user_email"] == f"dev{user_team_id}@example.com"
    assert seen[0].headers["authorization"] == f"Bearer {generated['key']}"
    assert generated["key"] != settings.api_key
    assert "999" not in api.users


@pytest.mark.parametrize("incomplete", [True, False])
def test_recommendations_reject_missing_verified_identity_without_io(
    settings: LiteLLMSettings, incomplete: bool
) -> None:
    def unexpected(request: httpx.Request) -> httpx.Response:
        pytest.fail("Incomplete verified identity must not make any LiteLLM request")

    auth = (
        AuthData(user_team_id=12, session_refresh_token="trusted-refresh")
        if incomplete
        else verified_user().model_copy(update={"user_email": " "})
    )
    payload = recommendation_request().model_dump(mode="json", by_alias=True)
    # Caller-supplied fields must not fill gaps in auth-service data.
    payload.update(team_id=7, user_email="spoofed@example.com", organization_name="Dev", role="admin")
    response = asyncio.run(call_recommender(settings, unexpected, payload, auth_data=auth, management=unexpected))
    assert response.status_code == 503
    assert response.json() == {"detail": "Model recommendation identity is unavailable"}
    assert response.headers["x-session-refresh-token"] == "trusted-refresh"


@pytest.mark.parametrize("failure", ["http", "timeout", "blocked-user", "blocked-key", "expired-key", "no-admin-key"])
def test_recommendation_identity_failures_never_fall_back_to_admin(settings: LiteLLMSettings, failure: str) -> None:
    api = IdentityAPI()

    def upstream(request: httpx.Request) -> httpx.Response:
        pytest.fail("Identity failures must not trigger inference with any credential")

    def management(request: httpx.Request) -> httpx.Response:
        if failure == "http":
            return httpx.Response(503, text="private task backend-only-key")
        if failure == "timeout":
            raise httpx.ReadTimeout("private task backend-only-key", request=request)
        if failure == "no-admin-key":
            pytest.fail("Missing management credentials must fail before upstream I/O")
        response = api(request)
        if response.is_success:
            payload = response.json()
            if failure == "blocked-user" and request.url.path == "/user/list":
                payload["users"] = [{**record, "blocked": True} for record in payload["users"]]
            elif failure in {"blocked-key", "expired-key"} and request.url.path == "/key/info":
                payload["info"].update(
                    {"blocked": True} if failure == "blocked-key" else {"expires": "2000-01-01T00:00:00Z"}
                )
            return httpx.Response(200, json=payload)
        return response

    if failure == "no-admin-key":
        settings = replace(settings, api_key="")
    payload = recommendation_request().model_dump(mode="json", by_alias=True)
    response = asyncio.run(call_recommender(settings, upstream, payload, management=management))
    denied = failure in {"blocked-user", "blocked-key", "expired-key"}
    assert response.status_code == (403 if denied else 503)
    assert response.json() == {
        "detail": "LiteLLM access denied" if denied else "Model recommendation identity is unavailable"
    }
    assert "backend-only-key" not in response.text
    assert "private task" not in response.text
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
