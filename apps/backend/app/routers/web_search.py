"""Authenticated web-search API for the standalone Pi extension."""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import ValidationError

from app.authentication import require_authenticated_user
from app.clients.auth_service import AuthData, AuthenticatedUser
from app.core.config import Settings, get_settings
from app.core.web_search import WEB_SEARCH_PATH
from app.services.web_search import WebSearchError, WebSearchRequest, WebSearchResponse, search_web

router = APIRouter(prefix=WEB_SEARCH_PATH, tags=["web-search"])


@router.post("", response_model=WebSearchResponse, response_model_exclude_none=True)
async def web_search(
    search: WebSearchRequest,
    request: Request,
    response: Response,
    auth_data: Annotated[AuthData, Depends(require_authenticated_user)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> WebSearchResponse:
    response.headers["Cache-Control"] = "no-store"
    try:
        user = AuthenticatedUser.model_validate(auth_data.model_dump())
    except ValidationError:
        raise HTTPException(status_code=503, detail="Search identity is unavailable") from None
    try:
        return await search_web(request, user, settings, search)
    except WebSearchError as exc:
        # Never expose upstream bodies, credentials, or the user's query.
        raise HTTPException(
            status_code=exc.status_code, detail=str(exc), headers={"Cache-Control": "no-store"}
        ) from exc
