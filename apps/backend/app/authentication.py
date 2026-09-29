"""Reusable DeputyDev session guard for API routes and ASGI proxies."""

from fastapi import HTTPException, Request, Response

from app.clients.auth_service import AuthenticatedUser, AuthServiceError, get_auth_service_client


async def authenticate_request(request: Request) -> AuthenticatedUser:
    """Validate the caller with deputydev-auth and attach canonical identity to the request."""
    credentials = request.headers.getlist("authorization")
    if len(credentials) != 1 or not credentials[0]:
        raise AuthServiceError("Missing or ambiguous authorization", status_code=401)

    grace_params = {
        name: value
        for name in ("use_grace_period", "enable_grace_period")
        if (value := request.query_params.get(name)) is not None
    }
    try:
        user = await get_auth_service_client(request).get_auth_data(credentials[0], grace_params)
    except RuntimeError as exc:
        raise AuthServiceError("Auth service is unavailable") from exc
    request.state.authenticated_user = user
    return user


async def require_authenticated_user(request: Request, response: Response) -> AuthenticatedUser:
    """Apply the guard to FastAPI endpoints with Depends or router dependencies."""
    try:
        user = await authenticate_request(request)
    except AuthServiceError as exc:
        detail = {
            401: "Authentication required",
            403: "Access denied",
        }.get(exc.status_code, "Auth service is unavailable")
        raise HTTPException(status_code=exc.status_code, detail=detail) from exc

    if user.session_refresh_token:
        response.headers["x-session-refresh-token"] = user.session_refresh_token
    response.headers["Cache-Control"] = "no-store"
    return user