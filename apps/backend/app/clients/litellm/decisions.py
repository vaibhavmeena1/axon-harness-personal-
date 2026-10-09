"""Typed System One decisions over the application's shared LiteLLM transport."""

from collections.abc import Mapping
from typing import Any

import httpx

from app.clients.litellm.transport import LiteLLMTransport
from app.core.config import LiteLLMSettings

SYSTEMONE_PATH = "/v1/systemone"


class LiteLLMDecisionError(RuntimeError):
    """Raised when a LiteLLM decision request fails, without exposing upstream content."""


class LiteLLMDecisionClient:
    """Use backend credentials for non-streaming decisions; the lifespan owns the pool."""

    def __init__(self, settings: LiteLLMSettings, transport: LiteLLMTransport) -> None:
        self.settings = settings
        self._transport = transport

    async def create_decision(self, request: Mapping[str, Any]) -> dict[str, Any]:
        """Send the state/questions format, not the distinct /v1/decisions input format."""
        if request.get("stream") is True:
            raise ValueError("System One decisions do not support streaming")

        try:
            response = await self._transport.request(
                "POST",
                SYSTEMONE_PATH,
                api_key=self.settings.api_key,
                timeout_seconds=self.settings.decision_timeout_seconds,
                payload=dict(request),
            )
        except httpx.HTTPError:
            raise LiteLLMDecisionError("LiteLLM decision request failed") from None

        if not response.is_success:
            raise LiteLLMDecisionError(f"LiteLLM decision returned HTTP {response.status_code}")
        try:
            payload = response.json()
        except ValueError:
            raise LiteLLMDecisionError("LiteLLM decision returned invalid JSON") from None
        if not isinstance(payload, dict):
            raise LiteLLMDecisionError("LiteLLM decision returned a non-object response")
        return payload
