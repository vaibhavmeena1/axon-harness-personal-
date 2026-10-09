"""LiteLLM resources are application-scoped and shared across proxy and tools."""

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi import FastAPI

from app.clients.litellm.transport import LiteLLMTransport
from app.core.config import LiteLLMSettings
from app.listeners import litellm


def configured_settings() -> SimpleNamespace:
    return SimpleNamespace(
        litellm=LiteLLMSettings(
            upstream_url="http://litellm.test",
            upstream_root_path="/",
            connect_timeout_seconds=10,
            pool_timeout_seconds=10,
            max_connections=10,
            max_keepalive_connections=5,
            keepalive_expiry_seconds=5,
            api_key="admin-key",
        ),
    )


def test_lifecycle_wires_one_pool_and_detaches_before_closing(monkeypatch: pytest.MonkeyPatch) -> None:
    settings = configured_settings()
    monkeypatch.setattr(litellm, "get_settings", lambda: settings)

    async def run() -> None:
        first, second = FastAPI(), FastAPI()
        await litellm.initialize_litellm_proxy(first)
        await litellm.initialize_litellm_proxy(second)
        transport = first.state.litellm_transport
        assert transport is not second.state.litellm_transport
        assert first.state.litellm_identity_client._transport is transport
        close = transport.aclose

        async def assert_detached() -> None:
            assert first.state.litellm_transport is None
            assert first.state.litellm_identity_client is None
            await close()

        transport.aclose = AsyncMock(side_effect=assert_detached)
        try:
            await litellm.close_litellm_proxy(first)
            await litellm.close_litellm_proxy(first)
            transport.aclose.assert_awaited_once()
        finally:
            await close()
            await litellm.close_litellm_proxy(second)

    asyncio.run(run())


def test_composition_failure_closes_created_pool(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(litellm, "get_settings", configured_settings)
    transport = AsyncMock(spec=LiteLLMTransport)
    monkeypatch.setattr(litellm, "LiteLLMTransport", Mock(return_value=transport))
    monkeypatch.setattr(litellm, "LiteLLMIdentityClient", Mock(side_effect=RuntimeError("composition failed")))
    with pytest.raises(RuntimeError, match="composition failed"):
        asyncio.run(litellm.initialize_litellm_proxy(FastAPI()))
    transport.aclose.assert_awaited_once()
