"""Provision verified DeputyDev identities through stock LiteLLM management APIs."""

import asyncio
import hashlib
import hmac
import json
import time
from collections import OrderedDict
from datetime import datetime, timezone
from typing import Any

import httpx

from app.clients.auth_service import AuthenticatedUser
from app.core.config import LiteLLMSettings

LITELLM_IDENTITY_CLIENT_STATE_KEY = "litellm_identity_client"


class LiteLLMIdentityError(Exception):
    """A sanitized synchronization failure; never include upstream bodies or keys."""

    def __init__(self, message: str, *, upstream_status_code: int | None = None, status_code: int = 503) -> None:
        super().__init__(message)
        self.upstream_status_code = upstream_status_code
        self.status_code = status_code


class LiteLLMIdentityClient:
    """Reuse native users, teams, memberships, and a backend-only key per user/team."""

    def __init__(self, settings: LiteLLMSettings, client: httpx.AsyncClient) -> None:
        self.settings = settings
        self._client = client
        self._cache: OrderedDict[tuple[int, str], tuple[float, str]] = OrderedDict()
        # Coalesce provisioning in this worker. Read-back also handles creation
        # races with other workers without overwriting existing budgets or roles.
        self._lock = asyncio.Lock()

    def _url(self, path: str) -> httpx.URL:
        root_path = self.settings.upstream_root_path.rstrip("/")
        return httpx.URL(self.settings.upstream_url).copy_with(path=root_path + path)

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
            response = await self._client.request(
                method,
                self._url(path),
                headers={"Authorization": f"Bearer {self.settings.api_key}"},
                params=params,
                json=payload,
                timeout=httpx.Timeout(self.settings.identity_sync_timeout_seconds),
                follow_redirects=False,
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

    def _virtual_key(self, user_team_id: str, team_id: str) -> str:
        # Domain-separated HMAC makes the key reusable across backend restarts
        # without storing plaintext credentials in another database or file.
        # Changing the configured admin key creates a new derived virtual key.
        identity = json.dumps(["meta-harness/litellm-key/v1", user_team_id, team_id], separators=(",", ":"))
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

    async def _provision(self, user: AuthenticatedUser) -> str:
        # LiteLLM calls this field user_id, but DeputyDev's canonical identifier
        # is the verified membership's user_team_id, not the account-level ID.
        user_id = str(user.user_team_id)
        team_id = self.settings.team_id or str(user.team_id)
        if self.settings.team_id:
            # Validate the configured team before creating a user or granting membership.
            await self._existing_team(team_id)
        user_payload: dict[str, Any] = {
            "user_id": user_id,
            "user_email": user.user_email,
            "user_alias": user.user_name,
            "user_role": "internal_user",
            "auto_create_key": False,
            "send_invite_email": False,
            "metadata": {"source": "meta-harness", "deputydev_user_team_id": user_id},
        }
        if self.settings.team_id:
            user_payload["teams"] = [{"team_id": team_id, "user_role": self.settings.team_role}]
        user_record = await self._ensure_record(
            "/user/info",
            "/user/new",
            {"user_id": user_id},
            "user_info",
            {"user_id": user_id},
            user_payload,
        )
        # Do not attach a DeputyDev identity to an unrelated existing native user.
        existing_email = user_record.get("user_email")
        if existing_email and (
            not isinstance(existing_email, str) or existing_email.casefold() != user.user_email.casefold()
        ):
            raise LiteLLMIdentityError("LiteLLM user ID is already assigned to a different identity")
        if self.settings.team_id:
            # /user/new can attach membership, so read it back before adding an existing user.
            team_record = await self._existing_team(team_id)
        else:
            team_record = await self._ensure_record(
                "/team/info",
                "/team/new",
                {"team_id": team_id},
                "team_info",
                {"team_id": team_id},
                {
                    "team_id": team_id,
                    "team_alias": user.organization_name or f"DeputyDev team {team_id}",
                    "members_with_roles": [{"user_id": user_id, "role": self.settings.team_role}],
                    "metadata": {"source": "meta-harness", "deputydev_team_id": str(user.team_id)},
                },
            )
        if user_record.get("blocked") is True or team_record.get("blocked") is True:
            raise LiteLLMIdentityError("LiteLLM user or team is disabled", status_code=403)
        await self._ensure_membership(team_record, user_id, team_id)

        virtual_key = self._virtual_key(user_id, team_id)
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
                "key_type": "llm_api",
                "user_id": user_id,
                "team_id": team_id,
                "metadata": {
                    "source": "meta-harness",
                    "deputydev_user_team_id": user_id,
                    "deputydev_team_id": str(user.team_id),
                },
            },
        )
        # Reuse restrictions as configured in LiteLLM; never unblock keys, reset
        # spend, alter budgets, or fall back to an admin key for model traffic.
        self._require_active_key(key_record)
        return virtual_key

    def _cached_key(self, identity: tuple[int, str]) -> str | None:
        cached = self._cache.get(identity)
        if cached is None:
            return None
        expires_at, virtual_key = cached
        if expires_at <= time.monotonic():
            del self._cache[identity]
            return None
        self._cache.move_to_end(identity)
        return virtual_key

    async def ensure_identity(self, user: AuthenticatedUser) -> str:
        """Return a native user/team key only after verified identity synchronization."""
        if not self.settings.api_key:
            raise LiteLLMIdentityError("LITELLM.API_KEY must be an admin key when identity synchronization is enabled")
        identity = (user.user_team_id, self.settings.team_id or str(user.team_id))
        cached_key = self._cached_key(identity)
        if cached_key is not None:
            return cached_key
        try:
            async with asyncio.timeout(self.settings.identity_sync_timeout_seconds):
                async with self._lock:
                    cached_key = self._cached_key(identity)
                    if cached_key is not None:
                        return cached_key
                    virtual_key = await self._provision(user)
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
