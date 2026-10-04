"""Reusable DeputyDev session guard for API routes and ASGI proxies."""

from fastapi import HTTPException, Request, Response
from pydantic import ValidationError
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

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


class AuthenticatedSessionMiddleware:
    """Validate Pi's opaque encrypted session before entering the streaming proxy."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        request = Request(scope)
        try:
            credentials = request.headers.getlist("authorization")
            if len(credentials) != 1:
                raise AuthServiceError("Missing or ambiguous authorization", status_code=401)
            scheme, separator, encrypted_session = credentials[0].partition(" ")
            if (
                scheme.lower() != "bearer"
                or not separator
                or not encrypted_session
                or any(not 33 <= ord(character) <= 126 for character in encrypted_session)
            ):
                raise AuthServiceError("Invalid encrypted session credential", status_code=401)

            # Only deputydev-auth decrypts and validates the session. Never trust
            # identity or session headers supplied separately by the caller.
            await authenticate_identity(request)
            request.state.encrypted_session_data = encrypted_session
        except AuthServiceError as exc:
            detail = {401: "Authentication required", 403: "Access denied"}.get(
                exc.status_code, "Auth service is unavailable"
            )
            response = JSONResponse(
                {"detail": detail}, status_code=exc.status_code, headers={"Cache-Control": "no-store"}
            )
            await response(scope, receive, send)
            return

        # Pure ASGI middleware leaves request/response streams untouched.
        await self.app(scope, receive, send)


class SessionRefreshResponseMiddleware:
    """Preserve trusted session rotations even when routing or upstream calls fail."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_authenticated_response(message: Message) -> None:
            auth_data = scope.get("state", {}).get("auth_data")
            if (
                message["type"] == "http.response.start"
                and isinstance(auth_data, AuthData)
                and auth_data.session_refresh_token
            ):
                # Use only the auth-service credential, never an upstream header.
                headers = [
                    (name, value)
                    for name, value in message.get("headers", [])
                    if name.lower() not in {b"x-session-refresh-token", b"cache-control"}
                ]
                headers.extend(
                    [
                        (b"x-session-refresh-token", auth_data.session_refresh_token.encode("utf-8")),
                        (b"cache-control", b"no-store"),
                    ]
                )
                message = {**message, "headers": headers}
            await send(message)

        # A send wrapper preserves SSE/body streaming and also covers HTTPException
        # and request-validation responses after a dependency has authenticated.
        await self.app(scope, receive, send_authenticated_response)


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
