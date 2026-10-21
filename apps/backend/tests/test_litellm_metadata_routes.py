"""Metadata access remains self-scoped and preserves operator-owned key policy."""

import asyncio
import hashlib
import json
from copy import deepcopy
from urllib.parse import parse_qsl

import httpx
import pytest
from fastapi import FastAPI
from starlette.types import Message

from app.clients.auth_service import AuthenticatedUser
from app.clients.litellm.identity import LiteLLMIdentityClient, LiteLLMIdentityError
from app.clients.litellm.transport import LiteLLMTransport
from app.core.config import LiteLLMSettings
from app.proxies.litellm import LiteLLMProxy, _metadata_query_string
from tests.test_litellm_identity import NATIVE_USER_ID, IdentityAPI
from tests.test_litellm_streaming import verified_scope

pytest_plugins = ["tests.test_litellm_identity"]

EXPECTED_ROUTES = ["llm_api_routes", "/key/info", "/v2/user/info", "/team/*", "/v1/systemone"]


def stored_policy(settings: LiteLLMSettings) -> dict:
    return {
        "user_id": NATIVE_USER_ID,
        "team_id": settings.team_id,
        "key_type": "llm_api",
        "allowed_routes": ["llm_api_routes"],
        "models": ["allowed-model"],
        "max_budget": 5,
        "spend": 2,
        "rpm_limit": 10,
        "permissions": {"custom": True},
        "object_permission": {"mcp_servers": ["operator-owned-server"]},
        "metadata": {"source": "meta-harness", "axon_user_id": "42", "operator": "owned"},
    }


@pytest.mark.parametrize(
    "old_routes",
    [
        ["llm_api_routes"],
        ["llm_api_routes", "/key/info", "/v2/user/info"],
        ["llm_api_routes", "/key/info", "/v2/user/info", "/team/*"],
    ],
)
def test_migrate_original_managed_key_preserves_other_policies(
    settings: LiteLLMSettings, user: AuthenticatedUser, old_routes: list[str]
) -> None:
    api = IdentityAPI()

    async def run() -> None:
        async with httpx.AsyncClient(transport=httpx.MockTransport(api)) as client:
            identity = LiteLLMIdentityClient(
                settings, LiteLLMTransport(settings, client=client, management_client=client)
            )
            key = identity._virtual_key("42", settings.team_id, NATIVE_USER_ID)
            key_hash = hashlib.sha256(key.encode()).hexdigest()
            original = stored_policy(settings)
            original["allowed_routes"] = old_routes
            api.keys[key_hash] = deepcopy(original)
            assert await identity.ensure_identity(user) == key
            assert api.keys[key_hash] == {**original, "allowed_routes": EXPECTED_ROUTES}
            assert api.posted("/key/update") == [{"key": key_hash, "allowed_routes": EXPECTED_ROUTES}]
            assert not api.posted("/key/generate")
            count = len(api.requests)
            assert await identity.ensure_identity(user) == key
            assert len(api.requests) == count
            # A fresh backend instance also sees the persisted upgrade, without writing again.
            another = LiteLLMIdentityClient(
                settings, LiteLLMTransport(settings, client=client, management_client=client)
            )
            assert await another.ensure_identity(user) == key
            assert len(api.posted("/key/update")) == 1

    asyncio.run(run())


@pytest.mark.parametrize(
    "policy",
    ["custom-routes", "already-upgraded", "unmanaged", "wrong-owner", "legacy-owner", "blocked", "expired"],
)
def test_do_not_override_custom_unmanaged_or_inactive_keys(
    settings: LiteLLMSettings, user: AuthenticatedUser, policy: str
) -> None:
    api = IdentityAPI()

    async def run() -> None:
        async with httpx.AsyncClient(transport=httpx.MockTransport(api)) as client:
            identity = LiteLLMIdentityClient(
                settings, LiteLLMTransport(settings, client=client, management_client=client)
            )
            key = identity._virtual_key("42", settings.team_id, NATIVE_USER_ID)
            key_hash = hashlib.sha256(key.encode()).hexdigest()
            original = stored_policy(settings)
            if policy == "custom-routes":
                original["allowed_routes"] = ["/v1/chat/completions"]
            elif policy == "already-upgraded":
                original["allowed_routes"] = EXPECTED_ROUTES
            elif policy == "unmanaged":
                original["metadata"]["source"] = "operator"
            elif policy == "wrong-owner":
                original["metadata"]["axon_user_id"] = "99"
                # A legacy membership marker is never an auth user identity.
                original["metadata"]["deputydev_user_team_id"] = "42"
            elif policy == "legacy-owner":
                original["metadata"].pop("axon_user_id")
                original["metadata"]["deputydev_user_team_id"] = "42"
            elif policy == "blocked":
                original["blocked"] = True
            else:
                original["expires"] = "2000-01-01T00:00:00Z"
            api.keys[key_hash] = deepcopy(original)
            if policy in {"blocked", "expired"}:
                with pytest.raises(LiteLLMIdentityError):
                    await identity.ensure_identity(user)
            else:
                assert await identity.ensure_identity(user) == key
            assert api.keys[key_hash] == original
            assert not api.posted("/key/update")
            assert not api.posted("/key/generate")

    asyncio.run(run())


@pytest.mark.parametrize("failure", ["rejected", "not-persisted"])
def test_failed_migration_fails_closed_without_caching(
    settings: LiteLLMSettings, user: AuthenticatedUser, failure: str
) -> None:
    api = IdentityAPI()
    api.key_update_status = 403 if failure == "rejected" else 200
    api.persist_key_update = False

    async def run() -> None:
        async with httpx.AsyncClient(transport=httpx.MockTransport(api)) as client:
            identity = LiteLLMIdentityClient(
                settings, LiteLLMTransport(settings, client=client, management_client=client)
            )
            key = identity._virtual_key("42", settings.team_id, NATIVE_USER_ID)
            api.keys[hashlib.sha256(key.encode()).hexdigest()] = stored_policy(settings)
            with pytest.raises(LiteLLMIdentityError):
                await identity.ensure_identity(user)
            assert not identity._cache
            api.key_update_status = 200
            api.persist_key_update = True
            assert await identity.ensure_identity(user) == key

    asyncio.run(run())


@pytest.mark.parametrize(
    "query", [b"", b"key=other-user-key", b"key=first&key=second&q=a%2Bb&q=&use_grace_period=false"]
)
@pytest.mark.parametrize("raw_path", [b"/edge/litellm/key/info", b"/edge/litellm/%6bey%2finfo"])
def test_key_info_hashes_and_pins_credential_without_leaking_it(
    settings: LiteLLMSettings, query: bytes, raw_path: bytes
) -> None:
    async def run() -> None:
        seen = []

        def upstream(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            # Native LiteLLM echoes the lookup key. This must never be our raw credential.
            return httpx.Response(200, json={"key": request.url.params["key"], "info": {"spend": 2, "max_budget": 5}})

        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
            transport = LiteLLMTransport(settings, client=client, management_client=client)
            identity = LiteLLMIdentityClient(settings, transport)
            user_key = "backend-only-key"
            identity._cache[("dev@example.test", 12, settings.team_id)] = (float("inf"), user_key)
            app = FastAPI()
            app.state.litellm_transport = transport
            app.state.litellm_identity_client = identity
            scope = verified_scope(app)
            scope.update(method="GET", path="/edge/litellm/key/info", raw_path=raw_path, query_string=query)
            messages = []

            async def receive() -> Message:
                return {"type": "http.request", "body": b""}

            async def send(message: Message) -> None:
                messages.append(message)

            await LiteLLMProxy()(scope, receive, send)
            assert messages[0]["status"] == 200
            expected_hash = hashlib.sha256(user_key.encode()).hexdigest()
            assert seen[0].url.params.get_list("key") == [expected_hash]
            assert seen[0].headers["authorization"] == f"Bearer {user_key}"
            body = b"".join(message.get("body", b"") for message in messages)
            assert user_key.encode() not in body
            assert json.loads(body) == {"key": expected_hash, "info": {"spend": 2, "max_budget": 5}}
            remaining = [
                (name, value) for name, value in parse_qsl(query.decode(), keep_blank_values=True) if name != "key"
            ]
            assert [(name, value) for name, value in seen[0].url.params.multi_items() if name != "key"] == remaining

    asyncio.run(run())


@pytest.mark.parametrize("method,path", [("POST", b"/key/info"), ("GET", b"/v2/user/info"), ("POST", b"/v1/responses")])
def test_other_queries_are_not_rewritten(method: str, path: bytes) -> None:
    query = b"key=original&q=a%2Bb&q=c"
    assert _metadata_query_string(method, path, query, "backend-key") == query
