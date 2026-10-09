"""Typed System One decisions over the application's shared LiteLLM transport."""

import asyncio
import logging
from collections.abc import Mapping
from typing import Any

import httpx

from app.clients.litellm.transport import LiteLLMTransport
from app.core.config import LiteLLMSettings

SYSTEMONE_PATH = "/v1/systemone"
logger = logging.getLogger(__name__)


class LiteLLMDecisionError(RuntimeError):
    """Raised when a LiteLLM decision request fails, without exposing upstream content."""


class LiteLLMDecisionClient:
    """Use caller-specific credentials for decisions over the buffered HTTP pool."""

    def __init__(self, settings: LiteLLMSettings, transport: LiteLLMTransport) -> None:
        self.settings = settings
        self._transport = transport
        # Decisions can hold a buffered connection for minutes. Capping them leaves the
        # rest of the management pool for identity sync, which every proxied request needs.
        self._slots = asyncio.Semaphore(settings.decision_max_concurrency)

    async def create_decision(self, request: Mapping[str, Any], *, api_key: str) -> dict[str, Any]:
        """Send the state/questions format, not the distinct /v1/decisions input format."""
        if request.get("stream") is True:
            raise ValueError("System One decisions do not support streaming")
        if not api_key or api_key == self.settings.api_key:
            raise LiteLLMDecisionError("A caller-specific LiteLLM key is required")

        # Recommendations are optional, so shed load instead of queueing behind slow decisions.
        if self._slots.locked():
            raise LiteLLMDecisionError("LiteLLM decision capacity is exhausted")
        async with self._slots:
            try:
                response = await self._transport.request(
                    "POST",
                    SYSTEMONE_PATH,
                    api_key=api_key,
                    timeout_seconds=self.settings.decision_timeout_seconds,
                    payload=dict(request),
                )
            except httpx.HTTPError:
                raise LiteLLMDecisionError("LiteLLM decision request failed") from None

        if response.status_code in {401, 403}:
            # Custom key policies are preserved during route upgrades and may omit this route.
            logger.warning(
                "LiteLLM denied the caller's decision request (HTTP %s); check that the key allows %s",
                response.status_code,
                SYSTEMONE_PATH,
            )
        if not response.is_success:
            raise LiteLLMDecisionError(f"LiteLLM decision returned HTTP {response.status_code}")
        try:
            payload = response.json()
        except ValueError:
            raise LiteLLMDecisionError("LiteLLM decision returned invalid JSON") from None
        if not isinstance(payload, dict):
            raise LiteLLMDecisionError("LiteLLM decision returned a non-object response")
        return payload
