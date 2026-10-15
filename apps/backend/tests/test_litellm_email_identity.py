"""Email is the only native-user lookup identity; Axon membership IDs are references."""

import asyncio
import hashlib
from copy import deepcopy
from dataclasses import replace

import httpx
import pytest

from app.clients.auth_service import AuthenticatedUser
from app.clients.litellm.identity import LiteLLMIdentityClient, LiteLLMIdentityError
from app.clients.litellm.transport import LiteLLMTransport
from app.core.config import LiteLLMSettings
from tests.test_litellm_identity import NATIVE_USER_ID, IdentityAPI, provision

pytest_plugins = ["tests.test_litellm_identity"]

MEMBERSHIP = "deputydev-user-team-id"


def test_verified_email_reuses_native_uuid_without_changing_user_policy(
    settings: LiteLLMSettings, user: AuthenticatedUser
) -> None:
    api = IdentityAPI()
    original = {
        "user_id": "litellm-generated-uuid",
        "user_email": "DEV@EXAMPLE.COM",
        "user_role": "internal_user_viewer",
        "metadata": {"operator": "owned"},
        "models": ["custom"],
        "max_budget": 20,
        "spend": 5,
    }
    api.users[original["user_id"]] = deepcopy(original)
    asyncio.run(provision(settings, user.model_copy(update={"user_email": " Dev@Example.com "}), api))

    assert not api.posted("/user/new")
    assert api.posted("/user/update") == [{"user_id": original["user_id"], "metadata": {MEMBERSHIP: ["12"]}}]
    assert api.users[original["user_id"]] == {
        **original,
        "metadata": {"operator": "owned", MEMBERSHIP: ["12"]},
    }
    assert api.posted("/key/generate")[0]["user_id"] == original["user_id"]
    assert api.posted("/team/member_add")[0]["member"]["user_id"] == original["user_id"]
    assert all(request.url.path != "/user/info" for request in api.requests)


@pytest.mark.parametrize("configured_team", [True, False])
def test_multiple_memberships_share_one_email_user_but_keep_separate_key_attribution(
    settings: LiteLLMSettings, user: AuthenticatedUser, configured_team: bool
) -> None:
    if not configured_team:
        settings = replace(settings, team_id="")
    api = IdentityAPI()
    other = user.model_copy(update={"user_team_id": 99, "team_id": 8})

    async def run() -> None:
        async with httpx.AsyncClient(transport=httpx.MockTransport(api)) as client:
            identity = LiteLLMIdentityClient(
                settings, LiteLLMTransport(settings, client=client, management_client=client)
            )
            first = await identity.ensure_identity(user)
            second = await identity.ensure_identity(other)
            assert first != second
            assert await identity.ensure_identity(user) == first
            assert await identity.ensure_identity(other) == second

    asyncio.run(run())
    assert len(api.users) == len(api.posted("/user/new")) == 1
    assert api.users[NATIVE_USER_ID]["metadata"][MEMBERSHIP] == ["12", "99"]
    keys = api.posted("/key/generate")
    assert [key["user_id"] for key in keys] == [NATIVE_USER_ID, NATIVE_USER_ID]
    assert [key["metadata"][MEMBERSHIP] for key in keys] == ["12", "99"]
    assert [key["metadata"]["axon_team_id"] for key in keys] == ["7", "8"]
    assert [key["team_id"] for key in keys] == ([settings.team_id, settings.team_id] if configured_team else ["7", "8"])
    assert all("user_id" not in creation for creation in api.posted("/user/new"))


@pytest.mark.parametrize("status", [400, 409, 500])
def test_create_conflict_is_accepted_only_after_exact_email_readback(
    settings: LiteLLMSettings, user: AuthenticatedUser, status: int
) -> None:
    api = IdentityAPI()

    def management(request: httpx.Request) -> httpx.Response:
        response = api(request)
        if request.url.path == "/user/new":
            # Another worker persisted the same email, with its own native ID.
            return httpx.Response(status, json={"error": "competing create"})
        return response

    asyncio.run(provision(settings, user, management))
    assert len(api.posted("/user/new")) == 1
    assert api.posted("/key/generate")[0]["user_id"] == NATIVE_USER_ID


@pytest.mark.parametrize("status", [200, 400, 409, 500])
def test_unpersisted_create_never_issues_a_key(settings: LiteLLMSettings, user: AuthenticatedUser, status: int) -> None:
    api = IdentityAPI()

    def management(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/user/new":
            return httpx.Response(status, json={"user_id": "unpersisted-generated-id"})
        return api(request)

    with pytest.raises(LiteLLMIdentityError):
        asyncio.run(provision(settings, user, management))
    assert not api.posted("/key/generate")
    assert not api.posted("/team/member_add")


@pytest.mark.parametrize("status", [401, 403, 404, 503])
def test_lookup_failures_are_not_interpreted_as_a_missing_email(
    settings: LiteLLMSettings, user: AuthenticatedUser, status: int
) -> None:
    api = IdentityAPI()

    def management(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/user/list":
            return httpx.Response(status)
        return api(request)

    with pytest.raises(LiteLLMIdentityError) as error:
        asyncio.run(provision(settings, user, management))
    assert error.value.upstream_status_code == status
    assert not api.posted("/user/new")
    assert not api.posted("/key/generate")


def test_partial_email_match_is_not_adopted(settings: LiteLLMSettings, user: AuthenticatedUser) -> None:
    api = IdentityAPI()
    unrelated = {"user_id": "unrelated-native-id", "user_email": "not-dev@example.com"}
    api.users[unrelated["user_id"]] = deepcopy(unrelated)
    asyncio.run(provision(settings, user, api))
    assert api.users[unrelated["user_id"]] == unrelated
    assert len(api.posted("/user/new")) == 1
    assert api.posted("/key/generate")[0]["user_id"] == NATIVE_USER_ID


def test_email_lookup_checks_all_pages_for_an_exact_match(settings: LiteLLMSettings, user: AuthenticatedUser) -> None:
    api = IdentityAPI()
    for index in range(100):
        native_id = f"a-{index:03}"
        api.users[native_id] = {"user_id": native_id, "user_email": f"other{index}-dev@example.com"}
    api.users["z-exact-native-id"] = {"user_id": "z-exact-native-id", "user_email": user.user_email}
    asyncio.run(provision(settings, user, api))
    assert not api.posted("/user/new")
    assert api.posted("/key/generate")[0]["user_id"] == "z-exact-native-id"
    pages = {request.url.params["page"] for request in api.requests if request.url.path == "/user/list"}
    assert pages == {"1", "2"}


def test_ambiguous_exact_email_fails_closed(settings: LiteLLMSettings, user: AuthenticatedUser) -> None:
    api = IdentityAPI()
    api.users["first"] = {"user_id": "first", "user_email": user.user_email}
    api.users["second"] = {"user_id": "second", "user_email": user.user_email.upper()}
    with pytest.raises(LiteLLMIdentityError, match="ambiguous"):
        asyncio.run(provision(settings, user, api))
    assert all(request.method == "GET" for request in api.requests)


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {"users": None, "page": 1, "total_pages": 1},
        {"users": [None], "page": 1, "total_pages": 1},
        {"users": [{"user_email": None}], "page": 1, "total_pages": 1},
        {"users": [{"user_email": "dev@example.com", "user_id": None}], "page": 1, "total_pages": 1},
        {"users": [{"user_email": "dev@example.com", "user_id": 12}], "page": 1, "total_pages": 1},
        {"users": [], "page": 1, "total_pages": True},
        {"users": [], "page": 1, "total_pages": 11},
        {"users": [], "page": 2, "total_pages": 2},
    ],
)
def test_malformed_or_unbounded_email_lookup_never_provisions(
    settings: LiteLLMSettings, user: AuthenticatedUser, payload: dict
) -> None:
    api = IdentityAPI()

    def management(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/user/list":
            return httpx.Response(200, json=payload)
        return api(request)

    with pytest.raises(LiteLLMIdentityError):
        asyncio.run(provision(settings, user, management))
    assert not api.posted("/user/new")
    assert not api.posted("/key/generate")


def test_metadata_reference_must_persist_before_caching_or_issuing_a_key(
    settings: LiteLLMSettings, user: AuthenticatedUser
) -> None:
    api = IdentityAPI()
    api.users[NATIVE_USER_ID] = {"user_id": NATIVE_USER_ID, "user_email": user.user_email}
    api.persist_user_update = False
    with pytest.raises(LiteLLMIdentityError, match="did not persist user membership references"):
        asyncio.run(provision(settings, user, api))
    assert not api.posted("/key/generate")


@pytest.mark.parametrize("metadata", [[], "invalid", {MEMBERSHIP: "12"}, {MEMBERSHIP: [{}]}])
def test_invalid_user_metadata_fails_closed(
    settings: LiteLLMSettings, user: AuthenticatedUser, metadata: object
) -> None:
    api = IdentityAPI()
    api.users[NATIVE_USER_ID] = {"user_id": NATIVE_USER_ID, "user_email": user.user_email, "metadata": metadata}
    with pytest.raises(LiteLLMIdentityError):
        asyncio.run(provision(settings, user, api))
    assert not api.posted("/user/update")
    assert not api.posted("/key/generate")


def test_blocked_email_user_is_not_modified(settings: LiteLLMSettings, user: AuthenticatedUser) -> None:
    api = IdentityAPI()
    api.users[NATIVE_USER_ID] = {"user_id": NATIVE_USER_ID, "user_email": user.user_email, "blocked": True}
    with pytest.raises(LiteLLMIdentityError) as error:
        asyncio.run(provision(settings, user, api))
    assert error.value.status_code == 403
    assert all(request.method == "GET" for request in api.requests)


def test_blank_verified_email_is_rejected_before_io(settings: LiteLLMSettings, user: AuthenticatedUser) -> None:
    api = IdentityAPI()
    with pytest.raises(LiteLLMIdentityError, match="email is unavailable"):
        asyncio.run(provision(settings, user.model_copy(update={"user_email": " "}), api))
    assert not api.requests


def test_native_key_owner_must_match_the_email_resolved_user(
    settings: LiteLLMSettings, user: AuthenticatedUser
) -> None:
    api = IdentityAPI()

    async def run() -> None:
        async with httpx.AsyncClient(transport=httpx.MockTransport(api)) as client:
            identity = LiteLLMIdentityClient(
                settings, LiteLLMTransport(settings, client=client, management_client=client)
            )
            key = identity._virtual_key("12", settings.team_id, NATIVE_USER_ID)
            api.keys[hashlib.sha256(key.encode()).hexdigest()] = {"user_id": "12", "team_id": settings.team_id}
            with pytest.raises(LiteLLMIdentityError, match="identity does not match"):
                await identity.ensure_identity(user)
            assert not identity._cache

    asyncio.run(run())
    assert not api.posted("/key/generate")


@pytest.mark.parametrize("next_email", [" DEV@EXAMPLE.COM ", "another@example.com"])
def test_cache_and_keys_follow_verified_email_changes(
    settings: LiteLLMSettings, user: AuthenticatedUser, next_email: str
) -> None:
    api = IdentityAPI()

    async def run() -> None:
        async with httpx.AsyncClient(transport=httpx.MockTransport(api)) as client:
            identity = LiteLLMIdentityClient(
                settings, LiteLLMTransport(settings, client=client, management_client=client)
            )
            first = await identity.ensure_identity(user)
            count = len(api.requests)
            second = await identity.ensure_identity(user.model_copy(update={"user_email": next_email}))
            if next_email.strip().casefold() == user.user_email:
                assert first == second
                assert len(api.requests) == count
            else:
                assert first != second
                assert len(api.users) == 2
                keys = api.posted("/key/generate")
                assert keys[0]["user_id"] != keys[1]["user_id"]
                assert [api.users[key["user_id"]]["user_email"] for key in keys] == [user.user_email, next_email]
                assert all(key["metadata"][MEMBERSHIP] == "12" for key in keys)

    asyncio.run(run())
