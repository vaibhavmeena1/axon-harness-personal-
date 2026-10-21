"""Public CLI release discovery and private release-upload URL signing."""

from hmac import compare_digest
from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, Response, status
from fastapi.responses import JSONResponse, RedirectResponse
from pydantic import BaseModel

from app.core.config import DEFAULT_CLI_RELEASE_TARGET, CliReleaseSettings, Settings, get_settings
from app.services.cli_releases import CliReleaseService, archive_for_version, checksums_text
from app.services.storage_dependencies import get_cli_release_service

router = APIRouter(prefix="/api/v1/cli/releases", tags=["cli-releases"])
NO_STORE = {"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"}


def enabled(settings: Settings) -> CliReleaseSettings:
    if settings.cli_releases is None:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "CLI releases are not configured")
    return settings.cli_releases


class PresignUploadRequest(BaseModel):
    version: str
    # Publishers from before x64 support send no target and upload darwin-arm64.
    target: str = DEFAULT_CLI_RELEASE_TARGET


class PresignUploadResponse(BaseModel):
    url: str
    headers: dict[str, str]
    expires_in: int


@router.post("/uploads/presign", response_model=PresignUploadResponse)
def presign_upload(
    request: PresignUploadRequest,
    settings: Annotated[Settings, Depends(get_settings)],
    response: Response,
    release_service: Annotated[CliReleaseService, Depends(get_cli_release_service)],
    authorization: Annotated[str | None, Header()] = None,
) -> PresignUploadResponse:
    releases = enabled(settings)
    if not authorization or not compare_digest(authorization, f"Bearer {releases.upload_auth_key}"):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid upload credentials")
    asset = archive_for_version(releases, request.version, request.target)
    if asset is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Release not found")
    url, headers = release_service.presign_s3_put(asset)
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


def checksums_response(settings: Settings, version: str, target: str) -> Response:
    releases = enabled(settings)
    asset = archive_for_version(releases, version, target)
    if asset is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Release not found")
    return Response(content=checksums_text(target, asset), media_type="text/plain", headers=NO_STORE)


@router.get("/{version}/checksums.txt")
def legacy_checksums(version: str, settings: Annotated[Settings, Depends(get_settings)]) -> Response:
    """Launchers released before x64 support read only darwin-arm64 hashes, from this name."""
    return checksums_response(settings, version, DEFAULT_CLI_RELEASE_TARGET)


@router.get("/{version}/checksums-{target}.txt")
def checksums(version: str, target: str, settings: Annotated[Settings, Depends(get_settings)]) -> Response:
    return checksums_response(settings, version, target)


@router.get("/{version}/axon-{target}.gz")
def download(
    version: str,
    target: str,
    settings: Annotated[Settings, Depends(get_settings)],
    release_service: Annotated[CliReleaseService, Depends(get_cli_release_service)],
) -> RedirectResponse:
    releases = enabled(settings)
    asset = archive_for_version(releases, version, target)
    if asset is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Release not found")
    return RedirectResponse(release_service.signed_cloudfront_get(asset), status_code=302, headers=NO_STORE)
