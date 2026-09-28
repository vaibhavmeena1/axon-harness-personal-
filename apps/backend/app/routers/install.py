"""Public installer script, rendered from the CLI source."""

import shlex
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Depends
from fastapi.responses import Response

from app.core.config import Settings, get_settings

router = APIRouter(tags=["install"])

# Keep one installer source for local development and the backend image.
INSTALLER_TEMPLATE_PATH = Path(__file__).resolve().parents[3] / "cli" / "install.sh"
DEFAULT_RELEASES_LINE = "DEFAULT_RELEASES_URL='https://YOUR_ORIGIN/api/v1/cli/releases'"
INSTALLER_TEMPLATE = INSTALLER_TEMPLATE_PATH.read_text(encoding="utf-8")
if INSTALLER_TEMPLATE.count(DEFAULT_RELEASES_LINE) != 1:
    raise RuntimeError("CLI installer release URL marker must appear exactly once")


@router.get("/install.sh", include_in_schema=False)
def install_script(settings: Annotated[Settings, Depends(get_settings)]) -> Response:
    """Serve a standalone shell script with only its public release URL substituted."""
    script = INSTALLER_TEMPLATE.replace(
        DEFAULT_RELEASES_LINE,
        f"DEFAULT_RELEASES_URL={shlex.quote(settings.cli_install.releases_url)}",
    )
    return Response(
        content=script,
        media_type="text/x-shell",
        headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"},
    )
