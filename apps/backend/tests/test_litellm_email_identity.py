"""Email resolves native users; verified auth user IDs own attribution and keys."""

import asyncio
import hashlib
import hmac
import json
from copy import deepcopy

import httpx
import pytest

from app.clients.auth_service import AuthenticatedUser
from app.clients.litellm.identity import LiteLLMIdentityClient, LiteLLMIdentityError
from app.clients.litellm.transport import LiteLLMTransport
from app.core.config import LiteLLMSettings
from tests.test_litellm_identity import NATIVE_USER_ID, IdentityAPI, provision

pytest_plugins = ["tests.test_litellm_identity"]

AUTH_USER = "axon_user_id"


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
    assert api.posted("/user/update") == [{"user_id": original["user_id"], "metadata": {AUTH_USER: "42"}}]
    assert api.users[original["user_id"]] == {
        **original,
        "metadata": {"operator": "owned", AUTH_USER: "42"},
    }
    assert api.posted("/key/generate")[0]["user_id"] == original["user_id"]
    assert api.posted("/team/member_add")[0]["member"]["user_id"] == original["user_id"]
    assert all(request.url.path != "/user/info" for request in api.requests)


def test_auth_membership_fields_do_not_change_user_keys_or_cache(
    settings: LiteLLMSettings, user: AuthenticatedUser
) -> None:
    api = IdentityAPI()
    other = AuthenticatedUser.model_validate(
        {**user.model_dump(), "user_team_id": 99, "team_id": 8, "organization_name": "Other", "role": "admin"}
    )
    assert other == user

    async def run() -> None:
        async with httpx.AsyncClient(transport=httpx.MockTransport(api)) as client:
            identity = LiteLLMIdentityClient(
                settings, LiteLLMTransport(settings, client=client, management_client=client)
            )
            first = await identity.ensure_identity(user)
            count = len(api.requests)
            second = await identity.ensure_identity(other)
            assert first == second
            assert len(api.requests) == count
            assert await identity.ensure_identity(user) == first
            assert await identity.ensure_identity(other) == second

    asyncio.run(run())
    assert len(api.users) == len(api.posted("/user/new")) == 1
    assert api.users[NATIVE_USER_ID]["metadata"][AUTH_USER] == "42"
    keys = api.posted("/key/generate")
    assert len(keys) == 1
    assert keys[0]["user_id"] == NATIVE_USER_ID
    assert keys[0]["metadata"] == {"source": "meta-harness", AUTH_USER: "42"}
    assert keys[0]["team_id"] == settings.team_id
    assert all("user_id" not in creation for creation in api.posted("/user/new"))


def test_four_legacy_users_keep_native_ids_policy_and_old_keys(settings: LiteLLMSettings) -> None:
    api = IdentityAPI()
    originals = {}
    legacy_keys = {}
    for offset in range(4):
        native_id = str(12 + offset)  # Numeric native IDs are retained, not renamed.
        auth_id = 12 if offset == 0 else 42 + offset
        original = {
            "user_id": native_id,
            "user_email": f"existing{offset}@example.com",
            "user_role": "internal_user_viewer",
            "max_budget": 20,
            "spend": 5 + offset,
            "models": ["operator-model"],
            "metadata": {"deputydev-user-team-id": [native_id], "operator": "owned"},
        }
        originals[native_id] = deepcopy(original)
        api.users[native_id] = deepcopy(original)
        api.teams[settings.team_id]["members_with_roles"].append({"user_id": native_id, "role": "admin"})
        old_input = json.dumps(
            ["meta-harness/litellm-key/v2", native_id, native_id, settings.team_id], separators=(",", ":")
        )
        old_key = "sk-" + hmac.new(settings.api_key.encode(), old_input.encode(), hashlib.sha256).hexdigest()
        key_hash = hashlib.sha256(old_key.encode()).hexdigest()
        api.keys[key_hash] = {
            "user_id": native_id,
            "team_id": settings.team_id,
            "max_budget": 1,
            "spend": 0.5,
            "allowed_routes": ["/v1/chat/completions"],
            "metadata": {"source": "meta-harness", "deputydev-user-team-id": native_id},
        }
        legacy_keys[key_hash] = deepcopy(api.keys[key_hash])
        verified = AuthenticatedUser(user_id=auth_id, user_email=original["user_email"])
        new_key = asyncio.run(provision(settings, verified, api))
        assert new_key != old_key
        assert api.users[native_id] == {**original, "metadata": {**original["metadata"], AUTH_USER: str(auth_id)}}
        generated = api.posted("/key/generate")[-1]
        assert generated["user_id"] == native_id
        assert generated["metadata"] == {"source": "meta-harness", AUTH_USER: str(auth_id)}
        assert "max_budget" not in generated and "spend" not in generated
        # A fresh backend instance reuses the new key instead of creating another.
        assert asyncio.run(provision(settings, verified, api)) == new_key
    assert set(api.users) == set(originals)
    assert all(api.keys[key_hash] == policy for key_hash, policy in legacy_keys.items())
    assert len(api.posted("/key/generate")) == 4
    assert not api.posted("/user/new")
    assert not api.posted("/team/member_add")
    assert not api.posted("/key/update")


def test_different_auth_user_cannot_claim_an_email_already_bound_to_another_user(
    settings: LiteLLMSettings, user: AuthenticatedUser
) -> None:
    api = IdentityAPI()
    asyncio.run(provision(settings, user, api))
    original = deepcopy(api.users[NATIVE_USER_ID])
    with pytest.raises(LiteLLMIdentityError, match="different auth user"):
        asyncio.run(provision(settings, user.model_copy(update={"user_id": 99}), api))
    assert api.users[NATIVE_USER_ID] == original
    assert len(api.posted("/key/generate")) == 1


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
    with pytest.raises(LiteLLMIdentityError, match="did not persist auth user reference"):
        asyncio.run(provision(settings, user, api))
    assert not api.posted("/key/generate")


@pytest.mark.parametrize(
    "metadata", [[], "invalid", *[{AUTH_USER: value} for value in [12, [], {}, "", "0", "042", "x", "٤٢"]]]
)
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
            key = identity._virtual_key("42", settings.team_id, NATIVE_USER_ID)
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
                assert all(key["metadata"][AUTH_USER] == "42" for key in keys)

    asyncio.run(run())
