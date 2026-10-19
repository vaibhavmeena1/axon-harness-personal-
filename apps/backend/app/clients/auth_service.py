"""Private, pooled HTTP client for axon-auth session and identity lookups."""

from typing import Literal

import httpx
from fastapi import Request
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.core.config import AuthServiceSettings

AUTH_SERVICE_CLIENT_STATE_KEY = "auth_service_client"


class AuthServiceError(Exception):
    """The auth service is unavailable or returned an invalid response."""

    def __init__(self, message: str, status_code: int = 503) -> None:
        super().__init__(message)
        self.status_code = status_code


class AuthData(BaseModel):
    """Fields guaranteed by the auth-service contract used by the extension backend."""

    model_config = ConfigDict(extra="allow")

    user_team_id: int
    session_refresh_token: str | None = None


class AuthenticatedUser(AuthData):
    """Verified identity; email resolves a LiteLLM-generated native user ID."""

    # Axon IDs remain attribution references, not native LiteLLM user IDs.
    user_id: int | None = None
    team_id: int
    user_email: str
    user_name: str | None = None
    organization_name: str
    role: str


class AuthDataResponse(BaseModel):
    auth_data: AuthData
    response_headers: dict[str, str]


class AuthSessionVerification(BaseModel):
    status: Literal["VERIFIED", "NOT_VERIFIED", "EXPIRED"]


class AuthSessionVerificationResult(AuthSessionVerification):
    """Private auth-service response; credentials must never enter the public JSON body."""

    encrypted_session_data: str | None = Field(
        default=None, exclude=True, repr=False, min_length=1, max_length=1024 * 1024 - 1, pattern=r"^[!-~]+$"
    )


class AuthServiceClient:
    """Look up sessions and authenticated identities through the private auth service."""

    def __init__(self, settings: AuthServiceSettings) -> None:
        self._client = httpx.AsyncClient(
            base_url=settings.base_url,
            timeout=httpx.Timeout(
                settings.request_timeout_seconds,
                connect=settings.connect_timeout_seconds,
            ),
            follow_redirects=False,
            trust_env=False,
        )

    async def get_session(self, session_id: str) -> dict[str, object]:
        try:
            response = await self._client.get(
                "get-session",
                headers={"X-Unique-Session-Id": session_id},
            )
            response.raise_for_status()
            payload = response.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise AuthServiceError("Auth service session lookup failed") from exc
        if not isinstance(payload, dict):
            raise AuthServiceError("Auth service returned an invalid session")
        return payload

    async def get_auth_data(
        self,
        authorization: str,
        grace_params: dict[str, str],
    ) -> AuthDataResponse:
        """Validate a session and return auth data and response headers from axon-auth."""
        try:
            response = await self._client.get(
                "v2/get-auth-data",
                headers={"Authorization": authorization},
                # In-session requests need identity and must preserve any rotated credentials.
                params={**grace_params, "refresh_expired": "true"},
            )
            response.raise_for_status()
            auth_data = AuthDataResponse.model_validate(response.json())
        except httpx.HTTPStatusError as exc:
            status_code = exc.response.status_code
            if status_code not in {401, 403}:
                status_code = 503
            raise AuthServiceError("Authentication failed", status_code=status_code) from exc
        except (httpx.HTTPError, ValueError, ValidationError) as exc:
            raise AuthServiceError("Auth service identity lookup failed") from exc

        return auth_data

    async def verify_identity(self, authorization: str) -> dict[str, object]:
        """Obtain verified telemetry identity, preserving any refreshed session."""
        try:
            response = await self._client.post(
                "verify-auth-token",
                headers={"Authorization": authorization},
                params={"use_grace_period": "false", "enable_grace_period": "false"},
            )
            response.raise_for_status()
            payload = response.json()
        except httpx.HTTPStatusError as exc:
            status_code = exc.response.status_code if exc.response.status_code in {401, 403} else 503
            raise AuthServiceError("Identity verification failed", status_code=status_code) from exc
        except (httpx.HTTPError, ValueError) as exc:
            raise AuthServiceError("Auth service identity verification failed") from exc

        if not isinstance(payload, dict) or payload.get("status") not in ("VERIFIED", "EXPIRED", "NOT_VERIFIED"):
            raise AuthServiceError("Auth service returned an invalid identity")
        if payload["status"] == "NOT_VERIFIED":
            raise AuthServiceError("Authentication failed", status_code=401)
        return payload

    async def verify_auth_token(
        self, authorization: str, *, refresh_expired: bool = False
    ) -> AuthSessionVerificationResult:
        """Verify a session, optionally refreshing expired access tokens for startup."""
        try:
            response = await self._client.post(
                "v2/verify-auth-token",
                headers={"Authorization": authorization},
                params={"refresh_expired": str(refresh_expired).lower()},
            )
            response.raise_for_status()
            return AuthSessionVerificationResult.model_validate(response.json())
        except httpx.HTTPStatusError as exc:
            status_code = exc.response.status_code if exc.response.status_code in {401, 403} else 503
            raise AuthServiceError("Session verification failed", status_code=status_code) from exc
        except (httpx.HTTPError, ValueError, ValidationError) as exc:
            raise AuthServiceError("Auth service session verification failed") from exc

    async def close(self) -> None:
        await self._client.aclose()


def get_auth_service_client(request: Request) -> AuthServiceClient:
    """Return the shared client, or report that browser login is not configured."""
    client = getattr(request.app.state, AUTH_SERVICE_CLIENT_STATE_KEY, None)
    if not isinstance(client, AuthServiceClient):
        raise RuntimeError("Auth service client is not initialized")
    return client
