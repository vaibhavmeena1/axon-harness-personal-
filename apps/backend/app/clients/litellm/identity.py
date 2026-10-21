"""Provision verified Axon identities through stock LiteLLM management APIs."""

import asyncio
import hashlib
import hmac
import json
import logging
import time
from collections import OrderedDict
from datetime import datetime, timezone
from typing import Any

import httpx

from app.clients.auth_service import AuthenticatedUser
from app.clients.litellm.transport import LiteLLMTransport
from app.core.config import LiteLLMSettings

# Explicit routes are required: the llm_api preset overwrites allowed_routes.
_MANAGED_KEY_ROUTES = ("llm_api_routes", "/key/info", "/v2/user/info", "/team/*", "/v1/systemone")
_PREVIOUS_MANAGED_KEY_ROUTES = (
    ("llm_api_routes",),
    ("llm_api_routes", "/key/info", "/v2/user/info"),
    ("llm_api_routes", "/key/info", "/v2/user/info", "/team/*"),
)
logger = logging.getLogger(__name__)
_USER_METADATA_KEY = "axon_user_id"
_USER_LOOKUP_PAGE_SIZE = 100
_MAX_USER_LOOKUP_PAGES = 10


class LiteLLMIdentityError(Exception):
    """A sanitized synchronization failure; never include upstream bodies or keys."""

    def __init__(self, message: str, *, upstream_status_code: int | None = None, status_code: int = 503) -> None:
        super().__init__(message)
        self.upstream_status_code = upstream_status_code
        self.status_code = status_code


class LiteLLMIdentityClient:
    """Resolve email-owned native users and keys per verified user/configured LiteLLM team."""

    def __init__(self, settings: LiteLLMSettings, transport: LiteLLMTransport) -> None:
        self.settings = settings
        self._transport = transport
        self._cache: OrderedDict[tuple[str, int, str], tuple[float, str]] = OrderedDict()
        # Coalesce provisioning in this worker. Read-back also handles creation
        # races with other workers without overwriting existing budgets or roles.
        self._lock = asyncio.Lock()

    async def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, str] | None = None,
        payload: dict[str, Any] | None = None,
        allow_missing: bool = False,
    ) -> dict[str, Any] | None:
        try:
            response = await self._transport.request(
                method,
                path,
                api_key=self.settings.api_key,
                params=params,
                payload=payload,
                timeout_seconds=self.settings.identity_sync_timeout_seconds,
            )
        except httpx.HTTPError as exc:
            raise LiteLLMIdentityError(f"LiteLLM management request failed at {path}") from exc
        if allow_missing and response.status_code == 404:
            return None
        if not response.is_success:
            raise LiteLLMIdentityError(
                f"LiteLLM management request rejected at {path} (HTTP {response.status_code})",
                upstream_status_code=response.status_code,
            )
        try:
            result = response.json()
        except ValueError as exc:
            raise LiteLLMIdentityError(f"Invalid LiteLLM management response at {path}") from exc
        if not isinstance(result, dict):
            raise LiteLLMIdentityError(f"Invalid LiteLLM management response at {path}")
        return result

    async def _lookup(
        self, path: str, params: dict[str, str], record_field: str, expected: dict[str, str]
    ) -> dict[str, Any] | None:
        result = await self._request("GET", path, params=params, allow_missing=True)
        if result is None:
            return None
        # Native info endpoints wrap records, while some versions return them
        # directly. An explicit null record also means the identity is absent.
        record = result.get(record_field) if record_field in result else result
        if record is None:
            return None
        if not isinstance(record, dict) or any(str(record.get(name)) != value for name, value in expected.items()):
            raise LiteLLMIdentityError(f"LiteLLM identity does not match at {path}")
        return record

    async def _ensure_record(
        self,
        info_path: str,
        create_path: str,
        params: dict[str, str],
        record_field: str,
        expected: dict[str, str],
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        record = await self._lookup(info_path, params, record_field, expected)
        if record is not None:
            return record
        try:
            await self._request("POST", create_path, payload=payload)
        except LiteLLMIdentityError as exc:
            if exc.upstream_status_code not in {400, 409, 500}:
                raise
            # Never interpret arbitrary create errors as success. The exact
            # record must exist after a competing worker created it.
            record = await self._lookup(info_path, params, record_field, expected)
            if record is None:
                raise exc
            return record
        record = await self._lookup(info_path, params, record_field, expected)
        if record is None:
            raise LiteLLMIdentityError(f"LiteLLM did not persist the identity at {create_path}")
        return record

    async def _user_by_email(self, email: str) -> dict[str, Any] | None:
        """LiteLLM's email filter is a substring search, not an identity lookup."""
        matched: dict[str, Any] | None = None
        for page in range(1, _MAX_USER_LOOKUP_PAGES + 1):
            result = await self._request(
                "GET",
                "/user/list",
                params={
                    "user_email": email,
                    "page": str(page),
                    "page_size": str(_USER_LOOKUP_PAGE_SIZE),
                    "sort_by": "user_id",
                    "sort_order": "asc",
                },
            )
            if result is None:
                raise LiteLLMIdentityError("Invalid LiteLLM user email lookup")
            records = result.get("users")
            pages = result.get("total_pages")
            if (
                not isinstance(records, list)
                or len(records) > _USER_LOOKUP_PAGE_SIZE
                or type(pages) is not int
                or not 0 <= pages <= _MAX_USER_LOOKUP_PAGES
                or type(result.get("page")) is not int
                or result.get("page") != page
                or (pages == 0 and records)
            ):
                raise LiteLLMIdentityError("Invalid LiteLLM user email lookup")
            for record in records:
                if not isinstance(record, dict) or not isinstance(record.get("user_email"), str):
                    raise LiteLLMIdentityError("Invalid LiteLLM user email lookup")
                if record["user_email"].strip().casefold() != email:
                    continue
                native_id = record.get("user_id")
                if not isinstance(native_id, str) or not native_id.strip():
                    raise LiteLLMIdentityError("LiteLLM email lookup returned no native user ID")
                if matched is not None and matched["user_id"] != native_id:
                    raise LiteLLMIdentityError("LiteLLM email lookup is ambiguous")
                matched = record
            if page >= pages:
                return matched
        raise LiteLLMIdentityError("LiteLLM user email lookup exceeded its page limit")

    async def _ensure_user(self, user: AuthenticatedUser, email: str, team_id: str) -> dict[str, Any]:
        """Resolve only by verified email; LiteLLM owns all native user IDs."""
        record = await self._user_by_email(email)
        if record is None:
            payload: dict[str, Any] = {
                "user_email": email,
                "user_alias": user.user_name,
                "user_role": "internal_user",
                "auto_create_key": False,
                "send_invite_email": False,
                "metadata": {"source": "meta-harness", _USER_METADATA_KEY: str(user.user_id)},
                "teams": [{"team_id": team_id, "user_role": self.settings.team_role}],
            }
            try:
                # Do not supply user_id, including on a create retry.
                await self._request("POST", "/user/new", payload=payload)
            except LiteLLMIdentityError as exc:
                if exc.upstream_status_code not in {400, 409, 500}:
                    raise
                # Other workers may create the same unique email concurrently.
                record = await self._user_by_email(email)
                if record is None:
                    raise exc
            else:
                record = await self._user_by_email(email)
                if record is None:
                    raise LiteLLMIdentityError("LiteLLM did not persist the user email")
        if record.get("blocked") is True:
            raise LiteLLMIdentityError("LiteLLM user is disabled", status_code=403)
        return await self._ensure_user_metadata(record, email, str(user.user_id))

    @staticmethod
    def _auth_user_reference(record: dict[str, Any]) -> str | None:
        metadata = record.get("metadata")
        if metadata is None:
            return None
        if not isinstance(metadata, dict):
            raise LiteLLMIdentityError("Invalid LiteLLM user metadata")
        reference = metadata.get(_USER_METADATA_KEY)
        if reference is not None and (
            not isinstance(reference, str)
            or not reference.isascii()
            or not reference.isdecimal()
            or reference.startswith("0")
        ):
            raise LiteLLMIdentityError("Invalid LiteLLM auth user reference")
        return reference

    async def _ensure_user_metadata(self, record: dict[str, Any], email: str, auth_user_id: str) -> dict[str, Any]:
        """Bind an email-resolved native user to one verified auth user, preserving legacy metadata."""
        reference = self._auth_user_reference(record)
        if reference == auth_user_id:
            return record
        if reference is not None:
            raise LiteLLMIdentityError("LiteLLM email user belongs to a different auth user")
        # /user/update merges metadata. Never send roles, budgets, or a complete
        # metadata snapshot that could overwrite unrelated operator fields.
        await self._request(
            "POST",
            "/user/update",
            payload={
                "user_id": record["user_id"],
                "metadata": {_USER_METADATA_KEY: auth_user_id},
            },
        )
        updated = await self._user_by_email(email)
        if (
            updated is None
            or updated["user_id"] != record["user_id"]
            or self._auth_user_reference(updated) != auth_user_id
        ):
            raise LiteLLMIdentityError("LiteLLM did not persist auth user reference")
        if updated.get("blocked") is True:
            raise LiteLLMIdentityError("LiteLLM user is disabled", status_code=403)
        return updated

    @staticmethod
    def _has_member(team: dict[str, Any], user_id: str) -> bool:
        members = team.get("members_with_roles")
        if not isinstance(members, list):
            raise LiteLLMIdentityError("LiteLLM returned invalid team membership data")
        return any(isinstance(member, dict) and str(member.get("user_id")) == user_id for member in members)

    async def _existing_team(self, team_id: str) -> dict[str, Any]:
        """Require an operator-selected team; never create or change its policies."""
        team = await self._lookup("/team/info", {"team_id": team_id}, "team_info", {"team_id": team_id})
        if team is None:
            raise LiteLLMIdentityError("Configured LiteLLM team does not exist")
        if team.get("blocked") is True:
            raise LiteLLMIdentityError("LiteLLM team is disabled", status_code=403)
        return team

    async def _ensure_membership(self, team: dict[str, Any], user_id: str, team_id: str) -> None:
        if self._has_member(team, user_id):
            return
        try:
            await self._request(
                "POST",
                "/team/member_add",
                payload={"team_id": team_id, "member": {"user_id": user_id, "role": self.settings.team_role}},
            )
        except LiteLLMIdentityError as exc:
            if exc.upstream_status_code not in {400, 409, 500}:
                raise
            current_team = await self._lookup("/team/info", {"team_id": team_id}, "team_info", {"team_id": team_id})
            if current_team is None or not self._has_member(current_team, user_id):
                raise exc
            return
        current_team = await self._lookup("/team/info", {"team_id": team_id}, "team_info", {"team_id": team_id})
        if current_team is None or not self._has_member(current_team, user_id):
            raise LiteLLMIdentityError("LiteLLM did not persist team membership")

    def _virtual_key(self, auth_user_id: str, team_id: str, native_user_id: str) -> str:
        # Domain separation prevents reuse of an old membership-scoped key, even
        # when auth user_id and the former membership ID are numerically equal.
        # Native identity and configured LiteLLM team are bound too. Changing the
        # admin key creates a new derived key; no plaintext credential is stored.
        identity = json.dumps(
            ["meta-harness/litellm-key/v3/user-id", native_user_id, auth_user_id, team_id], separators=(",", ":")
        )
        signature = hmac.new(self.settings.api_key.encode("ascii"), identity.encode("ascii"), hashlib.sha256)
        return "sk-" + signature.hexdigest()

    @staticmethod
    def _require_active_key(record: dict[str, Any]) -> None:
        if (
            record.get("blocked") is True
            or record.get("deleted_at") is not None
            or record.get("status") in ("revoked", "deleted", "expired")
        ):
            raise LiteLLMIdentityError("LiteLLM user/team key is disabled", status_code=403)
        expires = record.get("expires")
        if expires is not None:
            if not isinstance(expires, str):
                raise LiteLLMIdentityError("LiteLLM returned invalid key expiration")
            try:
                expiry = datetime.fromisoformat(expires.replace("Z", "+00:00"))
            except ValueError as exc:
                raise LiteLLMIdentityError("LiteLLM returned invalid key expiration") from exc
            if expiry.tzinfo is None:
                expiry = expiry.replace(tzinfo=timezone.utc)
            if expiry <= datetime.now(timezone.utc):
                raise LiteLLMIdentityError("LiteLLM user/team key is expired", status_code=403)

    async def _ensure_metadata_routes(
        self, record: dict[str, Any], key_hash: str, user_id: str, team_id: str, auth_user_id: str
    ) -> dict[str, Any]:
        """Upgrade only previous harness defaults; preserve custom policies."""
        metadata = record.get("metadata")
        routes = record.get("allowed_routes")
        if (
            not isinstance(metadata, dict)
            or metadata.get("source") != "meta-harness"
            or metadata.get(_USER_METADATA_KEY) != auth_user_id
            or not isinstance(routes, list)
            or tuple(routes) not in _PREVIOUS_MANAGED_KEY_ROUTES
        ):
            return record
        await self._request(
            "POST", "/key/update", payload={"key": key_hash, "allowed_routes": list(_MANAGED_KEY_ROUTES)}
        )
        updated = await self._lookup("/key/info", {"key": key_hash}, "info", {"user_id": user_id, "team_id": team_id})
        if updated is None or updated.get("allowed_routes") != list(_MANAGED_KEY_ROUTES):
            raise LiteLLMIdentityError("LiteLLM did not persist managed key metadata routes")
        logger.info("LiteLLM managed key metadata routes upgraded user_id=%s", auth_user_id)
        return updated

    async def _provision(self, user: AuthenticatedUser, email: str) -> str:
        auth_user_id = str(user.user_id)
        team_id = self.settings.team_id
        if not team_id:
            raise LiteLLMIdentityError("LITELLM.TEAM_ID must select an existing LiteLLM team")
        # Validate the operator-selected team before any user/key writes. Auth
        # service membership, team, organization and role never select policies.
        await self._existing_team(team_id)
        user_record = await self._ensure_user(user, email, team_id)
        user_id = user_record["user_id"]
        # /user/new can attach membership; read it back before adding an existing user.
        team_record = await self._existing_team(team_id)
        if user_record.get("blocked") is True or team_record.get("blocked") is True:
            raise LiteLLMIdentityError("LiteLLM user or team is disabled", status_code=403)
        await self._ensure_membership(team_record, user_id, team_id)

        virtual_key = self._virtual_key(auth_user_id, team_id, user_id)
        key_hash = hashlib.sha256(virtual_key.encode("ascii")).hexdigest()
        key_record = await self._ensure_record(
            "/key/info",
            "/key/generate",
            # Query only the hash so access logs cannot expose the raw key.
            {"key": key_hash},
            "info",
            {"user_id": user_id, "team_id": team_id},
            {
                "key": virtual_key,
                "key_alias": f"meta-harness:{user_id}:{team_id}:{key_hash[:12]}",
                "key_type": "default",
                "allowed_routes": list(_MANAGED_KEY_ROUTES),
                "user_id": user_id,
                "team_id": team_id,
                "metadata": {
                    "source": "meta-harness",
                    _USER_METADATA_KEY: auth_user_id,
                },
            },
        )
        # Never unblock keys, reset spend/budgets, change custom routes, or fall
        # back to an admin key. Only previous harness route defaults are upgraded.
        self._require_active_key(key_record)
        key_record = await self._ensure_metadata_routes(key_record, key_hash, user_id, team_id, auth_user_id)
        self._require_active_key(key_record)
        return virtual_key

    def _cached_key(self, identity: tuple[str, int, str]) -> str | None:
        cached = self._cache.get(identity)
        if cached is None:
            return None
        expires_at, virtual_key = cached
        if expires_at <= time.monotonic():
            del self._cache[identity]
            return None
        self._cache.move_to_end(identity)
        return virtual_key

    async def authenticated_key(self, user: AuthenticatedUser) -> str:
        """Resolve model credentials without ever falling back after a sync failure."""
        if not self.settings.identity_sync_enabled:
            return self.settings.api_key
        return await self.ensure_identity(user)

    async def ensure_identity(self, user: AuthenticatedUser) -> str:
        """Return a native user/team key only after verified identity synchronization."""
        if not self.settings.api_key:
            raise LiteLLMIdentityError("LITELLM.API_KEY must be an admin key when identity synchronization is enabled")
        email = user.user_email.strip().casefold()
        if not email:
            raise LiteLLMIdentityError("Verified user email is unavailable")
        identity = (email, user.user_id, self.settings.team_id)
        cached_key = self._cached_key(identity)
        if cached_key is not None:
            return cached_key
        try:
            async with asyncio.timeout(self.settings.identity_sync_timeout_seconds):
                async with self._lock:
                    cached_key = self._cached_key(identity)
                    if cached_key is not None:
                        return cached_key
                    virtual_key = await self._provision(user, email)
                    if self.settings.identity_sync_cache_seconds:
                        self._cache[identity] = (
                            time.monotonic() + self.settings.identity_sync_cache_seconds,
                            virtual_key,
                        )
                        while len(self._cache) > self.settings.identity_sync_cache_max_entries:
                            self._cache.popitem(last=False)
                    return virtual_key
        except TimeoutError as exc:
            raise LiteLLMIdentityError("LiteLLM identity synchronization timed out") from exc
