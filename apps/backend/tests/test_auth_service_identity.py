"""Existing verify-auth-token API supports minimal get-auth-data deployments."""

import asyncio

import httpx
import pytest

from app.clients.auth_service import AuthServiceClient, AuthServiceError
from app.core.config import AuthServiceSettings


@pytest.mark.parametrize(
    "status,payload,expected",
    [
        (200, {"status": "VERIFIED", "user_email": "verified@example.com", "user_name": "Verified"}, None),
        (200, {"status": "EXPIRED", "user_email": "verified@example.com", "encrypted_session_data": "rotated"}, None),
        (200, {"status": "NOT_VERIFIED", "error_message": "private-token"}, 401),
        (200, {"status": []}, 503),
        (200, [], 503),
        (200, {"status": "unknown"}, 503),
        (401, {"detail": "private-token"}, 401),
        (403, {"detail": "private-token"}, 403),
        (500, {"detail": "private-token"}, 503),
    ],
)
def test_verified_identity_contract(status: int, payload: object, expected: int | None) -> None:
    async def run() -> None:
        seen = []

        def service(request: httpx.Request) -> httpx.Response:
            seen.append(request)
            return httpx.Response(status, json=payload)

        client = AuthServiceClient(AuthServiceSettings("https://auth.test/", "https://login.test/external-auth", 1, 1))
        await client._client.aclose()
        client._client = httpx.AsyncClient(base_url="https://auth.test/", transport=httpx.MockTransport(service))
        try:
            if expected is None:
                assert await client.verify_identity("Bearer saved-secret") == payload
            else:
                with pytest.raises(AuthServiceError) as error:
                    await client.verify_identity("Bearer saved-secret")
                assert error.value.status_code == expected
                assert "private-token" not in str(error.value)
            assert len(seen) == 1
            assert seen[0].method == "POST"
            assert seen[0].url.path == "/verify-auth-token"
            assert seen[0].headers["Authorization"] == "Bearer saved-secret"
            assert dict(seen[0].url.params) == {"use_grace_period": "false", "enable_grace_period": "false"}
        finally:
            await client.close()

    asyncio.run(run())
