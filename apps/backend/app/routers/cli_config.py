"""Protected CLI preferences. Browser login and releases remain separate APIs."""

from typing import Annotated, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from app.authentication import require_authenticated_user
from app.core.cli_config import CliPiConfig, CliTelemetryConfig
from app.core.config import Settings, get_settings
from app.core.terminal_permissions import CliTerminalPermissionsConfig
from app.core.web_search import CliWebSearchConfig

router = APIRouter(prefix="/api/v1/cli/config", tags=["cli-config"], dependencies=[Depends(require_authenticated_user)])


class CliConfigResponse(BaseModel):
    schema_version: Literal[1] = Field(default=1, alias="schemaVersion")
    telemetry: CliTelemetryConfig | None = None
    pi: CliPiConfig | None = None
    web_search: CliWebSearchConfig | None = Field(default=None, alias="webSearch")
    terminal_permissions: CliTerminalPermissionsConfig | None = Field(default=None, alias="terminalPermissions")


@router.get("", response_model=CliConfigResponse, response_model_exclude_none=True)
async def client_config(settings: Annotated[Settings, Depends(get_settings)]) -> CliConfigResponse:
    # Explicit projection only: never return auth_data, refresh tokens, or backend settings.
    return CliConfigResponse(
        telemetry=settings.cli_telemetry,
        pi=settings.cli_pi,
        webSearch=settings.web_search.cli_config(),
        terminalPermissions=settings.terminal_permissions.cli_config()
        if settings.terminal_permissions is not None
        else None,
    )
