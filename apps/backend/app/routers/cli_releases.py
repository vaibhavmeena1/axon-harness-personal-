"""Public CLI release discovery and private release-upload URL signing."""

from hmac import compare_digest
from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, Response, status
from fastapi.responses import JSONResponse, RedirectResponse
from pydantic import BaseModel

from app.core.config import CliReleaseSettings, Settings, get_settings
from app.services.cli_releases import (
    ARCHIVE_NAME,
    BINARY_NAME,
    archive_for_version,
    presign_s3_put,
    signed_cloudfront_get,
)

router = APIRouter(prefix="/api/v1/cli/releases", tags=["cli-releases"])
NO_STORE = {"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"}


def enabled(settings: Settings) -> CliReleaseSettings:
    if settings.cli_releases is None:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "CLI releases are not configured")
    return settings.cli_releases


class PresignUploadRequest(BaseModel):
    version: str


class PresignUploadResponse(BaseModel):
    url: str
    headers: dict[str, str]
    expires_in: int


@router.post("/uploads/presign", response_model=PresignUploadResponse)
def presign_upload(
    request: PresignUploadRequest,
    settings: Annotated[Settings, Depends(get_settings)],
    response: Response,
    authorization: Annotated[str | None, Header()] = None,
) -> PresignUploadResponse:
    releases = enabled(settings)
    if not authorization or not compare_digest(authorization, f"Bearer {releases.upload_auth_key}"):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid upload credentials")
    asset = archive_for_version(releases, request.version)
    if asset is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Release not found")
    url, headers = presign_s3_put(releases, asset)
    response.headers.update(NO_STORE)
    return PresignUploadResponse(url=url, headers=headers, expires_in=releases.put_url_expiry_seconds)


@router.get("/latest")
def latest(settings: Annotated[Settings, Depends(get_settings)]) -> JSONResponse:
    releases = enabled(settings)
    if not releases.latest_version:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "No CLI release is published")
    return JSONResponse({"version": releases.latest_version}, headers=NO_STORE)


@router.get("/latest/VERSION")
def latest_version(settings: Annotated[Settings, Depends(get_settings)]) -> Response:
    releases = enabled(settings)
    if not releases.latest_version:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "No CLI release is published")
    return Response(content=f"{releases.latest_version}\n", media_type="text/plain", headers=NO_STORE)


@router.get("/{version}/checksums.txt")
def checksums(version: str, settings: Annotated[Settings, Depends(get_settings)]) -> Response:
    releases = enabled(settings)
    asset = archive_for_version(releases, version)
    if asset is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Release not found")
    return Response(
        content=f"{asset.archive_sha256}  {ARCHIVE_NAME}\n{asset.binary_sha256}  {BINARY_NAME}\n",
        media_type="text/plain",
        headers=NO_STORE,
    )


@router.get(f"/{{version}}/{ARCHIVE_NAME}")
def download(version: str, settings: Annotated[Settings, Depends(get_settings)]) -> RedirectResponse:
    releases = enabled(settings)
    asset = archive_for_version(releases, version)
    if asset is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Release not found")
    return RedirectResponse(signed_cloudfront_get(releases, asset), status_code=302, headers=NO_STORE)
