"""Native user/team provisioning preserves operator-owned LiteLLM policies."""

import asyncio
import hashlib
import json
from copy import deepcopy
from dataclasses import replace
from typing import Any

import httpx
import pytest

from app.clients.auth_service import AuthenticatedUser
from app.clients.litellm.identity import LiteLLMIdentityClient, LiteLLMIdentityError
from app.clients.litellm.transport import LiteLLMTransport
from app.core.config import LiteLLMSettings


@pytest.fixture
def settings() -> LiteLLMSettings:
    return LiteLLMSettings(
        upstream_url="http://litellm.test",
        upstream_root_path="/",
        connect_timeout_seconds=10,
        pool_timeout_seconds=10,
        max_connections=10,
        max_keepalive_connections=5,
        keepalive_expiry_seconds=5,
        api_key="admin-key",
        identity_sync_enabled=True,
        team_id="existing-team-id",
    )


@pytest.fixture
def user() -> AuthenticatedUser:
    return AuthenticatedUser(
        user_team_id=12,
        user_id=42,
        team_id=7,
        user_email="dev@example.com",
        user_name="Developer",
        organization_name="Dev",
        role="member",
    )


class IdentityAPI:
    """In-memory management API; inspect writes without calling a real LiteLLM."""

    def __init__(self) -> None:
        self.users: dict[str, dict[str, Any]] = {}
        self.teams: dict[str, dict[str, Any]] = {
            "existing-team-id": {
                "team_id": "existing-team-id",
                "team_alias": "Operator-managed team",
                "members_with_roles": [],
                "max_budget": 100,
                "models": ["allowed-model"],
                "metadata": {"operator": "owned"},
            }
        }
        self.keys: dict[str, dict[str, Any]] = {}
        self.requests: list[httpx.Request] = []
        self.attach_teams_on_user_create = True
        self.persist_membership = True
        self.persist_key_update = True
        self.key_update_status = 200

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path = request.url.path
        if request.method == "GET":
            table, parameter, field = {
                "/user/info": (self.users, "user_id", "user_info"),
                "/team/info": (self.teams, "team_id", "team_info"),
                "/key/info": (self.keys, "key", "info"),
            }[path]
            record = table.get(request.url.params[parameter])
            return httpx.Response(200, json={field: record}) if record is not None else httpx.Response(404)

        payload = json.loads(request.content)
        if path == "/user/new":
            self.users[payload["user_id"]] = deepcopy(payload)
            if self.attach_teams_on_user_create:
                for membership in payload.get("teams", []):
                    self.teams[membership["team_id"]]["members_with_roles"].append(
                        {"user_id": payload["user_id"], "role": membership["user_role"]}
                    )
        elif path == "/team/new":
            self.teams[payload["team_id"]] = deepcopy(payload)
        elif path == "/team/member_add":
            if self.persist_membership:
                self.teams[payload["team_id"]]["members_with_roles"].append(deepcopy(payload["member"]))
        elif path == "/key/generate":
            self._generate_key(payload)
        elif path == "/key/update":
            return self._update_key(payload)
        else:
            raise AssertionError(f"Unexpected management write: {path}")
        return httpx.Response(200, json={})

    def _generate_key(self, payload: dict[str, Any]) -> None:
        key_hash = hashlib.sha256(payload["key"].encode()).hexdigest()
        self.keys[key_hash] = deepcopy(payload)
        # Stock LiteLLM's llm_api preset overrides any explicit route list.
        if payload.get("key_type") == "llm_api":
            self.keys[key_hash]["allowed_routes"] = ["llm_api_routes"]

    def _update_key(self, payload: dict[str, Any]) -> httpx.Response:
        if self.key_update_status != 200:
            return httpx.Response(self.key_update_status, json={"error": "rejected"})
        if self.persist_key_update:
            self.keys[payload["key"]].update({name: value for name, value in payload.items() if name != "key"})
        return httpx.Response(200, json={})

    def posted(self, path: str) -> list[dict[str, Any]]:
        return [
            json.loads(request.content)
            for request in self.requests
            if request.method == "POST" and request.url.path == path
        ]


async def provision(settings: LiteLLMSettings, user: AuthenticatedUser, api: IdentityAPI) -> str:
    async with httpx.AsyncClient(transport=httpx.MockTransport(api)) as client:
        return await LiteLLMIdentityClient(
            settings, LiteLLMTransport(settings, client=client, management_client=client)
        ).authenticated_key(user)


@pytest.mark.parametrize("role", ["user", "admin"])
def test_new_user_joins_configured_team_without_budgets(
    settings: LiteLLMSettings, user: AuthenticatedUser, role: str
) -> None:
    api = IdentityAPI()
    original_team = deepcopy(api.teams[settings.team_id])
    key = asyncio.run(provision(replace(settings, team_role=role), user, api))

    creation = api.posted("/user/new")[0]
    assert creation["teams"] == [{"team_id": settings.team_id, "user_role": role}]
    assert creation["user_id"] == "12"
    assert creation["user_role"] == "internal_user"
    assert creation["auto_create_key"] is False
    assert creation["send_invite_email"] is False
    assert "max_budget" not in creation
    assert not api.posted("/team/new")
    assert not api.posted("/team/member_add")

    generated = api.posted("/key/generate")[0]
    assert generated["key"] == key
    assert generated["user_id"] == "12"
    assert generated["team_id"] == settings.team_id
    assert generated["key_type"] == "default"
    assert generated["allowed_routes"] == ["llm_api_routes", "/key/info", "/v2/user/info", "/team/*", "/v1/systemone"]
    assert not api.posted("/key/update")
    assert generated["metadata"]["axon_team_id"] == "7"
    assert "max_budget" not in generated
    original_team["members_with_roles"] = [{"user_id": "12", "role": role}]
    assert api.teams[settings.team_id] == original_team
    assert all(request.headers["authorization"] == "Bearer admin-key" for request in api.requests)
    key_lookups = [r for r in api.requests if r.url.path == "/key/info"]
    assert all(r.url.params["key"] == hashlib.sha256(key.encode()).hexdigest() for r in key_lookups)


@pytest.mark.parametrize("role", ["user", "admin"])
def test_existing_user_is_added_without_updating_user_policy(
    settings: LiteLLMSettings, user: AuthenticatedUser, role: str
) -> None:
    api = IdentityAPI()
    existing_user = {"user_id": "12", "user_email": user.user_email, "max_budget": 20, "models": ["custom"]}
    api.users["12"] = deepcopy(existing_user)
    asyncio.run(provision(replace(settings, team_role=role), user, api))

    assert not api.posted("/user/new")
    assert api.posted("/team/member_add") == [{"team_id": settings.team_id, "member": {"user_id": "12", "role": role}}]
    assert api.users["12"] == existing_user
    assert not api.posted("/team/new")


def test_existing_membership_and_key_policy_are_preserved(settings: LiteLLMSettings, user: AuthenticatedUser) -> None:
    api = IdentityAPI()
    # A role configured for new memberships must not overwrite the UI's role.
    api.users["12"] = {"user_id": "12", "user_email": user.user_email}
    api.teams[settings.team_id]["members_with_roles"] = [{"user_id": "12", "role": "admin"}]
    original_team = deepcopy(api.teams[settings.team_id])

    async def run() -> None:
        async with httpx.AsyncClient(transport=httpx.MockTransport(api)) as client:
            identity = LiteLLMIdentityClient(
                settings, LiteLLMTransport(settings, client=client, management_client=client)
            )
            key = identity._virtual_key("12", settings.team_id)
            key_hash = hashlib.sha256(key.encode()).hexdigest()
            stored_key = {"user_id": "12", "team_id": settings.team_id, "max_budget": 5, "models": ["custom"]}
            api.keys[key_hash] = deepcopy(stored_key)
            assert await identity.ensure_identity(user) == key
            assert api.keys[key_hash] == stored_key

    asyncio.run(run())
    assert api.teams[settings.team_id] == original_team
    assert not api.posted("/team/member_add")
    assert not api.posted("/key/generate")


@pytest.mark.parametrize("failure", ["missing", "blocked", "mismatched"])
def test_invalid_configured_team_fails_before_creating_user_or_key(
    settings: LiteLLMSettings, user: AuthenticatedUser, failure: str
) -> None:
    api = IdentityAPI()
    if failure == "missing":
        api.teams.clear()
    elif failure == "blocked":
        api.teams[settings.team_id]["blocked"] = True
    else:
        api.teams[settings.team_id]["team_id"] = "wrong-team"
    with pytest.raises(LiteLLMIdentityError):
        asyncio.run(provision(settings, user, api))
    assert all(request.method == "GET" for request in api.requests)


def test_blank_team_id_retains_axon_team_provisioning(settings: LiteLLMSettings, user: AuthenticatedUser) -> None:
    api = IdentityAPI()
    asyncio.run(provision(replace(settings, team_id="", team_role="admin"), user, api))
    assert "teams" not in api.posted("/user/new")[0]
    created_team = api.posted("/team/new")[0]
    assert created_team["team_id"] == "7"
    assert created_team["members_with_roles"] == [{"user_id": "12", "role": "admin"}]
    assert "max_budget" not in created_team
    assert api.posted("/key/generate")[0]["team_id"] == "7"


def test_new_user_membership_is_verified_even_if_teams_field_is_ignored(
    settings: LiteLLMSettings, user: AuthenticatedUser
) -> None:
    api = IdentityAPI()
    api.attach_teams_on_user_create = False
    asyncio.run(provision(settings, user, api))
    assert api.posted("/team/member_add") == [
        {"team_id": settings.team_id, "member": {"user_id": "12", "role": "user"}}
    ]


def test_unpersisted_membership_does_not_issue_key(settings: LiteLLMSettings, user: AuthenticatedUser) -> None:
    api = IdentityAPI()
    api.users["12"] = {"user_id": "12", "user_email": user.user_email}
    api.persist_membership = False
    with pytest.raises(LiteLLMIdentityError, match="did not persist team membership"):
        asyncio.run(provision(settings, user, api))
    assert not api.posted("/key/generate")


def test_existing_user_email_collision_does_not_grant_membership(
    settings: LiteLLMSettings, user: AuthenticatedUser
) -> None:
    api = IdentityAPI()
    api.users["12"] = {"user_id": "12", "user_email": "different@example.com"}
    with pytest.raises(LiteLLMIdentityError, match="different identity"):
        asyncio.run(provision(settings, user, api))
    assert not api.posted("/team/member_add")
    assert not api.posted("/key/generate")


def test_disabled_existing_key_is_not_replaced(settings: LiteLLMSettings, user: AuthenticatedUser) -> None:
    api = IdentityAPI()

    async def run() -> None:
        async with httpx.AsyncClient(transport=httpx.MockTransport(api)) as client:
            identity = LiteLLMIdentityClient(
                settings, LiteLLMTransport(settings, client=client, management_client=client)
            )
            key = identity._virtual_key("12", settings.team_id)
            api.keys[hashlib.sha256(key.encode()).hexdigest()] = {
                "user_id": "12",
                "team_id": settings.team_id,
                "blocked": True,
            }
            with pytest.raises(LiteLLMIdentityError, match="key is disabled") as error:
                await identity.ensure_identity(user)
            assert error.value.status_code == 403

    asyncio.run(run())
    assert not api.posted("/key/generate")


def test_same_identity_reuses_cached_key(settings: LiteLLMSettings, user: AuthenticatedUser) -> None:
    api = IdentityAPI()

    async def run() -> None:
        async with httpx.AsyncClient(transport=httpx.MockTransport(api)) as client:
            identity = LiteLLMIdentityClient(
                settings, LiteLLMTransport(settings, client=client, management_client=client)
            )
            key = await identity.ensure_identity(user)
            count = len(api.requests)
            assert await identity.ensure_identity(user) == key
            assert len(api.requests) == count

    asyncio.run(run())


def test_sync_disabled_uses_configured_key_without_management_requests(
    settings: LiteLLMSettings, user: AuthenticatedUser
) -> None:
    api = IdentityAPI()
    disabled = replace(settings, identity_sync_enabled=False)
    assert asyncio.run(provision(disabled, user, api)) == settings.api_key
    assert not api.requests
