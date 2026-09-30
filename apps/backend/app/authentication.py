"""Reusable DeputyDev session guard for API routes and ASGI proxies."""

from fastapi import HTTPException, Request, Response
from pydantic import ValidationError

from app.clients.auth_service import AuthData, AuthenticatedUser, AuthServiceError, get_auth_service_client

# Auth-service headers must not replace the route's own representation or framing.
_EXCLUDED_RESPONSE_HEADERS = {"cache-control", "connection", "content-length", "content-type", "transfer-encoding"}


async def authenticate_request(request: Request, *, parse_body: bool = False) -> AuthData:
    """Validate the caller with deputydev-auth and attach auth data to the request."""
    credentials = request.headers.getlist("authorization")
    if len(credentials) != 1 or not credentials[0].strip():
        raise AuthServiceError("Missing or ambiguous authorization", status_code=401)

    grace_params = {
        name: "true" if request.query_params.get(name, "false").lower() == "true" else "false"
        for name in ("use_grace_period", "enable_grace_period")
    }
    # FastAPI routes may supply these flags in POST JSON, as extension routes do.
    # The proxy does not opt in, so its streaming request body stays untouched.
    if parse_body and request.method == "POST" and "application/json" in request.headers.get("content-type", ""):
        try:
            payload = await request.json()
        except ValueError:
            payload = None
        if isinstance(payload, dict):
            for name in grace_params:
                grace_params[name] = "true" if payload.get(name) is True else "false"

    try:
        auth_response = await get_auth_service_client(request).get_auth_data(credentials[0], grace_params)
    except RuntimeError as exc:
        raise AuthServiceError("Auth service is unavailable") from exc
    request.state.auth_data = auth_response.auth_data
    request.state.auth_response_headers = auth_response.response_headers
    return auth_response.auth_data


async def authenticate_identity(request: Request) -> AuthenticatedUser:
    """Require the richer identity LiteLLM needs, without trusting caller-supplied fields."""
    auth_data = await authenticate_request(request)
    try:
        identity = AuthenticatedUser.model_validate(auth_data.model_dump())
    except ValidationError as exc:
        raise AuthServiceError("Auth service returned incomplete LiteLLM identity") from exc
    if not identity.user_email:
        raise AuthServiceError("Auth service returned an invalid identity")
    request.state.authenticated_user = identity
    return identity


async def require_authenticated_user(request: Request, response: Response) -> AuthData:
    """Protect an endpoint with Depends, or every endpoint on an APIRouter."""
    try:
        auth_data = await authenticate_request(request, parse_body=True)
    except AuthServiceError as exc:
        detail = {
            401: "Authentication required",
            403: "Access denied",
        }.get(exc.status_code, "Auth service is unavailable")
        raise HTTPException(
            status_code=exc.status_code,
            detail=detail,
            headers={"Cache-Control": "no-store"},
        ) from exc

    for name, value in request.state.auth_response_headers.items():
        if name.lower() not in _EXCLUDED_RESPONSE_HEADERS:
            response.headers[name] = value
    if auth_data.session_refresh_token:
        response.headers["x-session-refresh-token"] = auth_data.session_refresh_token
    response.headers["Cache-Control"] = "no-store"
    return auth_data