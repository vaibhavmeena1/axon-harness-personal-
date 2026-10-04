"""LiteLLM custom auth for identities validated by meta-harness."""

import asyncio
import base64
import binascii
import hashlib
import hmac
import json
import os
import secrets
import time
from typing import Any

from fastapi import Request
from litellm.proxy._types import LitellmUserRoles, ProxyException, UserAPIKeyAuth

_SYNCED_USERS: set[str] = set()
_SYNCED_TEAMS: set[str] = set()
_IDENTITY_SYNC_LOCK = asyncio.Lock()


def _required_environment(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        # A configuration failure must not trigger native-key fallback in auto mode.
        raise ProxyException(
            message="Gateway authentication is not configured",
            type="service_unavailable_error",
            param="api_key",
            code=503,
        )
    return value


def _unauthorized(message: str) -> ProxyException:
    return ProxyException(message=message, type="authentication_error", param="api_key", code=401)


def _identity_sync_unavailable() -> ProxyException:
    return ProxyException(
        message="Unable to synchronize the authenticated identity",
        type="service_unavailable_error",
        param="user_id",
        code=503,
    )


def _verify_identity_context(token: str) -> dict[str, Any]:
    """Verify the HMAC, intended audience, subject, and short validity window."""
    try:
        encoded_payload, encoded_signature = token.split(".")
        payload = encoded_payload.encode("ascii")
        signature = base64.b64decode(
            encoded_signature + "=" * (-len(encoded_signature) % 4),
            altchars=b"-_",
            validate=True,
        )
        expected = hmac.new(_required_environment("LITELLM_IDENTITY_SECRET").encode(), payload, hashlib.sha256).digest()
        if not hmac.compare_digest(signature, expected):
            raise ValueError("Invalid identity signature")
        claims = json.loads(base64.b64decode(payload + b"=" * (-len(payload) % 4), altchars=b"-_", validate=True))
        now = int(time.time())
        if (
            not isinstance(claims, dict)
            or claims.get("iss") != "meta-harness"
            or claims.get("aud") != "litellm"
            or not isinstance(claims.get("iat"), int)
            or not isinstance(claims.get("exp"), int)
            or isinstance(claims["iat"], bool)
            or isinstance(claims["exp"], bool)
            or claims["iat"] > now + 5
            or claims["exp"] < now - 5
            or not 0 < claims["exp"] - claims["iat"] <= 60
            or not isinstance(claims.get("user_id"), str)
            or not claims["user_id"]
            or not isinstance(claims.get("team_id"), str)
            or not claims["team_id"]
            or claims.get("sub") != claims["user_id"]
            or not isinstance(claims.get("jti"), str)
            or not claims["jti"]
        ):
            raise ValueError("Invalid identity claims")
        return claims
    except (ValueError, UnicodeError, TypeError, KeyError, binascii.Error) as error:
        raise _unauthorized("Invalid identity context") from error


def _verify_session_request(request: Request, claims: dict[str, Any]) -> None:
    """Verify that auth approved this opaque session for this specific request target."""
    session_headers = request.headers.getlist("x-encrypted-session-data")
    request_ids = request.headers.getlist("x-request-id")
    if len(session_headers) != 1 or not session_headers[0] or len(request_ids) != 1 or not request_ids[0]:
        raise _unauthorized("Missing or ambiguous session context")

    try:
        session_digest = hashlib.sha256(session_headers[0].encode("ascii")).hexdigest()
        query_string = request.scope.get("query_string", b"").decode("ascii")
        expected_digest = claims.get("session_sha256")
        if (
            not isinstance(expected_digest, str)
            or not hmac.compare_digest(session_digest, expected_digest)
            or request_ids[0] != claims.get("request_id")
            or request.method != claims.get("request_method")
            or request.url.path != claims.get("request_path")
            or query_string != claims.get("request_query")
        ):
            raise _unauthorized("Session request mismatch")
    except (UnicodeError, TypeError) as error:
        raise _unauthorized("Invalid session context") from error


async def _insert_record_if_missing(
    prisma_client: Any,
    table_name: str,
    lookup_field: str,
    lookup_value: str,
    data: dict[str, Any],
) -> None:
    """Create a LiteLLM record idempotently, including across workers and replicas."""
    lookup = {lookup_field: lookup_value}
    existing_record = await prisma_client.get_data(table_name=table_name, **lookup)
    if existing_record is not None:
        return

    try:
        await prisma_client.insert_data(table_name=table_name, data=data)
    except Exception as insertion_error:
        # Another worker may have inserted the same identity between lookup and insert.
        existing_record = await prisma_client.get_data(table_name=table_name, **lookup)
        if existing_record is None:
            raise insertion_error


async def _ensure_litellm_identity(claims: dict[str, Any], user_id: str, team_id: str) -> None:
    """Ensure the authenticated team and user exist before LiteLLM records spend."""
    if user_id in _SYNCED_USERS and team_id in _SYNCED_TEAMS:
        return

    # LiteLLM imports custom auth while its proxy server is initializing.
    from litellm.proxy.proxy_server import prisma_client

    if prisma_client is None:
        raise RuntimeError("LiteLLM database client is unavailable")

    async with _IDENTITY_SYNC_LOCK:
        organization_name = claims.get("organization_name")
        if team_id not in _SYNCED_TEAMS:
            team_metadata = {
                "identity_source": "deputydev-auth",
                "organization_name": organization_name,
            }
            await _insert_record_if_missing(
                prisma_client=prisma_client,
                table_name="team",
                lookup_field="team_id",
                lookup_value=team_id,
                data={
                    "team_id": team_id,
                    "team_alias": organization_name or f"DeputyDev team {team_id}",
                    "metadata": {key: value for key, value in team_metadata.items() if value is not None},
                },
            )
            _SYNCED_TEAMS.add(team_id)

        if user_id not in _SYNCED_USERS:
            user_metadata = {
                "identity_source": "deputydev-auth",
                "deputydev_user_team_id": claims.get("user_team_id"),
                "deputydev_role": claims.get("role"),
                "organization_name": organization_name,
            }
            await _insert_record_if_missing(
                prisma_client=prisma_client,
                table_name="user",
                lookup_field="user_id",
                lookup_value=user_id,
                data={
                    "user_id": user_id,
                    "user_alias": claims.get("user_name") or claims.get("user_email"),
                    "user_email": claims.get("user_email"),
                    "user_role": LitellmUserRoles.INTERNAL_USER,
                    "team_id": team_id,
                    "teams": [team_id],
                    "metadata": {key: value for key, value in user_metadata.items() if value is not None},
                },
            )
            _SYNCED_USERS.add(user_id)


async def user_api_key_auth(request: Request, api_key: str) -> UserAPIKeyAuth:
    """Permit the master key or a validated meta-harness service assertion."""
    master_key = _required_environment("LITELLM_MASTER_KEY")
    if secrets.compare_digest(api_key, master_key):
        return UserAPIKeyAuth(api_key=api_key, user_id="litellm-admin", user_role=LitellmUserRoles.PROXY_ADMIN)

    service_token = _required_environment("LITELLM_SERVICE_TOKEN")
    if not secrets.compare_digest(api_key, service_token):
        if "x-auth-context" in request.headers or "x-encrypted-session-data" in request.headers:
            # Gateway assertions must never fall back to native key validation.
            raise _unauthorized("Invalid gateway credential")
        # Allow LiteLLM's native verifier to handle its Admin UI and virtual keys.
        raise Exception("Credential is not managed by meta-harness")

    identity_tokens = request.headers.getlist("x-auth-context")
    if len(identity_tokens) != 1 or not identity_tokens[0]:
        raise _unauthorized("Missing or ambiguous identity context")
    claims = _verify_identity_context(identity_tokens[0])
    _verify_session_request(request, claims)

    user_id = claims["user_id"]
    team_id = claims["team_id"]
    metadata = {
        "request_id": claims.get("request_id"),
        "user_team_id": claims.get("user_team_id"),
        "organization_name": claims.get("organization_name"),
        "harness_id": claims.get("harness_id"),
        "role": claims.get("role"),
    }
    try:
        await _ensure_litellm_identity(claims=claims, user_id=user_id, team_id=team_id)
    except Exception as error:
        raise _identity_sync_unavailable() from error

    return UserAPIKeyAuth(
        api_key=api_key,
        key_alias="meta-harness-auth-wrapper",
        user_id=user_id,
        end_user_id=user_id,
        user_email=claims.get("user_email"),
        user_role=LitellmUserRoles.INTERNAL_USER,
        team_id=team_id,
        metadata={key: value for key, value in metadata.items() if value is not None},
    )
