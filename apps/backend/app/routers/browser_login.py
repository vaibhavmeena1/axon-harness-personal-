"""Browser-login handshake for DeputyDev CLI sessions."""

import logging
from typing import Annotated, Literal
from urllib.parse import urlencode, urlsplit, urlunsplit
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Path, Request, Response, status
from pydantic import BaseModel

from app.clients.auth_service import AuthServiceClient, AuthServiceError, get_auth_service_client
from app.core.config import get_settings

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1/auth/browser-login", tags=["auth"])


class BrowserLoginStart(BaseModel):
    session_id: str
    browser_url: str


class BrowserLoginSession(BaseModel):
    status: Literal["PENDING", "AUTHENTICATED"]
    encrypted_session_data: str | None = None
    user_email: str | None = None
    user_name: str | None = None


@router.post("", response_model=BrowserLoginStart)
async def start_browser_login(response: Response) -> BrowserLoginStart:
    """Create an unpredictable pairing ID and a browser URL owned by backend config."""
    settings = get_settings().auth_service
    if settings is None:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Browser login is not configured")

    session_id = str(uuid4())
    browser_url = urlsplit(settings.browser_login_url)
    response.headers["Cache-Control"] = "no-store"
    return BrowserLoginStart(
        session_id=session_id,
        browser_url=urlunsplit(
            browser_url._replace(query=urlencode({"unique_session_id": session_id, "is_external_auth_request": "CLI"}))
        ),
    )


@router.get("/{session_id}", response_model=BrowserLoginSession)
async def get_browser_login_session(
    session_id: Annotated[
        str,
        Path(pattern=r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"),
    ],
    request: Request,
    response: Response,
) -> BrowserLoginSession:
    """Poll deputydev-auth; never log or cache the encrypted credential."""
    if get_settings().auth_service is None:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Browser login is not configured")
    client: AuthServiceClient = get_auth_service_client(request)
    try:
        payload = await client.get_session(session_id)
        session = BrowserLoginSession.model_validate(payload)
        if session.status == "AUTHENTICATED" and not session.encrypted_session_data:
            raise ValueError("Authenticated response has no encrypted session")
    except (AuthServiceError, ValueError) as exc:
        # Never include upstream response bodies: they can contain credentials.
        logger.warning("Browser login session lookup failed")
        raise HTTPException(
            status.HTTP_502_BAD_GATEWAY,
            "Auth service is temporarily unavailable",
        ) from exc
    response.headers["Cache-Control"] = "no-store"
    return session
