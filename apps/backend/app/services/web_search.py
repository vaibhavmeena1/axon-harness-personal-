"""Grounded LLM calls through the existing stock LiteLLM deployment."""

import asyncio
import json
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlsplit
from uuid import uuid4

import httpx
from fastapi import Request
from pydantic import BaseModel, ConfigDict, Field

from app.clients.auth_service import AuthenticatedUser
from app.clients.litellm import LiteLLMIdentityError
from app.core.config import Settings
from app.core.web_search import WebSearchSettings
from app.proxies.litellm import LITELLM_CLIENT_STATE_KEY, authenticated_upstream_key

MAX_UPSTREAM_BYTES = 4 * 1024 * 1024


class WebSearchRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, strict=True)

    query: str = Field(min_length=1, max_length=100000)
    model: str | None = Field(default=None, min_length=1, max_length=256)
    max_output_tokens: int | None = Field(default=None, alias="maxOutputTokens", ge=1, le=65536)
    max_sources: int | None = Field(default=None, alias="maxSources", ge=1, le=100)
    max_result_characters: int | None = Field(default=None, alias="maxResultCharacters", ge=1, le=100000)


class SearchSource(BaseModel):
    title: str
    url: str


class WebSearchResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    answer: str
    sources: list[SearchSource]
    model: str
    grounded: bool
    search_queries: list[str] = Field(alias="searchQueries")
    truncated: bool = False
    search_entry_point: str | None = Field(default=None, alias="searchEntryPoint")


class WebSearchError(Exception):
    """Only sanitized messages may leave the backend."""

    def __init__(self, message: str, status_code: int = 502) -> None:
        super().__init__(message)
        self.status_code = status_code


def _records(value: Any) -> list[dict[str, Any]]:
    if isinstance(value, dict):
        return [value]
    if isinstance(value, list):
        return [item for item in value if isinstance(item, dict)]
    return []


def _message(payload: dict[str, Any]) -> dict[str, Any]:
    choices = _records(payload.get("choices"))
    message = choices[0].get("message") if choices else None
    return message if isinstance(message, dict) else {}


def _metadata(payload: dict[str, Any], message: dict[str, Any]) -> list[dict[str, Any]]:
    # Stock LiteLLM exposes provider metadata at the top level; some versions
    # carry it on the message instead. It can be a candidate list or an object.
    containers = [payload, message]
    for parent in (payload, message):
        containers.extend(_records(parent.get("provider_specific_fields")))
        containers.extend(_records(parent.get("_hidden_params")))
    metadata = []
    for container in containers:
        for name in ("vertex_ai_grounding_metadata", "groundingMetadata", "grounding_metadata"):
            metadata.extend(_records(container.get(name)))
    return metadata


def _source(source: dict[str, Any]) -> SearchSource | None:
    url = source.get("uri", source.get("url"))
    if not isinstance(url, str) or len(url) > 8192 or any(ord(char) < 32 for char in url):
        return None
    try:
        parsed = urlsplit(url)
    except ValueError:
        return None
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
        return None
    title = source.get("title")
    return SearchSource(title=title[:1000] if isinstance(title, str) else parsed.hostname, url=url)


def _web_sources(metadata: dict[str, Any]) -> list[dict[str, Any]]:
    chunks = metadata.get("groundingChunks", metadata.get("grounding_chunks"))
    return [web for chunk in _records(chunks) for web in _records(chunk.get("web"))]


def _search_queries(metadata: dict[str, Any]) -> list[str]:
    queries = metadata.get("webSearchQueries", metadata.get("web_search_queries"))
    if not isinstance(queries, list):
        return []
    return [query[:2000] for query in queries[:100] if isinstance(query, str) and query.strip()]


def _search_entry(metadata: dict[str, Any]) -> str | None:
    for entry in _records(metadata.get("searchEntryPoint", metadata.get("search_entry_point"))):
        rendered = entry.get("renderedContent", entry.get("rendered_content"))
        if isinstance(rendered, str):
            return rendered[:100000]
    return None


def _search_evidence(
    payload: dict[str, Any], message: dict[str, Any], max_sources: int
) -> tuple[list[SearchSource], list[str], str | None]:
    raw_sources = []
    queries: dict[str, None] = {}
    search_entry_point = None
    for metadata in _metadata(payload, message):
        raw_sources.extend(_web_sources(metadata))
        queries.update(dict.fromkeys(_search_queries(metadata)))
        search_entry_point = _search_entry(metadata) or search_entry_point
    # OpenAI-compatible citation annotations also survive stock proxy serialization.
    for annotation in _records(message.get("annotations")):
        if annotation.get("type") == "url_citation":
            raw_sources.extend(_records(annotation.get("url_citation")))
    sources: dict[str, SearchSource] = {}
    for raw_source in raw_sources:
        source = _source(raw_source)
        if source is not None:
            sources[source.url] = source
    return list(sources.values())[:max_sources], list(queries)[:100], search_entry_point


def _normalize(payload: dict[str, Any], model: str, max_sources: int, max_characters: int) -> WebSearchResponse:
    message = _message(payload)
    content = message.get("content")
    if isinstance(content, list):
        content = "\n".join(item["text"] for item in _records(content) if isinstance(item.get("text"), str))
    if not isinstance(content, str) or not content.strip():
        raise WebSearchError("Search returned no answer")
    sources, queries, search_entry_point = _search_evidence(payload, message, max_sources)
    return WebSearchResponse(
        answer=content[:max_characters],
        sources=sources,
        model=model,
        grounded=bool(sources or queries),
        search_queries=queries,
        truncated=len(content) > max_characters,
        search_entry_point=search_entry_point,
    )


def _selected_model(search: WebSearchRequest, policy: WebSearchSettings) -> str:
    if not policy.enabled:
        raise WebSearchError("Web search is disabled by your organization", 403)
    if not search.query.strip() or len(search.query) > policy.max_query_characters:
        raise WebSearchError("Search query is empty or exceeds the configured limit", 422)
    model = search.model or policy.model
    if model not in (policy.model, *policy.allowed_models):
        raise WebSearchError("Search model is not allowed by your organization", 403)
    return model


def _payload(
    search: WebSearchRequest, policy: WebSearchSettings, model: str, user: AuthenticatedUser
) -> dict[str, Any]:
    identity_metadata = {
        "request_id": str(uuid4()),
        "user_id": str(user.user_team_id),
        "user_team_id": str(user.user_team_id),
        "team_id": str(user.team_id),
        "harness_id": "pi",
        "tool": "web_search",
    }
    payload = {
        "model": model,
        "messages": [
            {
                "role": "system",
                "content": policy.system_prompt + f"\nCurrent UTC date: {datetime.now(timezone.utc).date()}",
            },
            {"role": "user", "content": search.query},
        ],
        "stream": False,
        "tools": [{policy.search_tool: {}}],
        "max_tokens": min(search.max_output_tokens or policy.max_output_tokens, policy.max_output_tokens),
        "temperature": policy.temperature,
        "user": str(user.user_team_id),
        "metadata": {**identity_metadata, "spend_logs_metadata": identity_metadata},
    }
    if policy.use_url_context:
        payload["tools"].append({"urlContext": {}})
    if policy.thinking_budget_tokens is not None:
        payload["thinking"] = {"type": "enabled", "budget_tokens": policy.thinking_budget_tokens}
    return payload


async def _read_completion(response: httpx.Response) -> dict[str, Any]:
    if response.status_code in {401, 403}:
        raise WebSearchError("LiteLLM search access denied", 403)
    if response.status_code == 429:
        raise WebSearchError("Search rate or budget limit reached", 429)
    if not response.is_success:
        raise WebSearchError("LiteLLM search request failed")
    body = bytearray()
    async for chunk in response.aiter_bytes():
        body.extend(chunk)
        if len(body) > MAX_UPSTREAM_BYTES:
            raise WebSearchError("Search response exceeds the size limit")
    result = json.loads(body)
    if not isinstance(result, dict):
        raise WebSearchError("Invalid search response")
    return result


async def _complete(
    request: Request, user: AuthenticatedUser, settings: Settings, payload: dict[str, Any]
) -> dict[str, Any]:
    client = getattr(request.app.state, LITELLM_CLIENT_STATE_KEY, None)
    if not isinstance(client, httpx.AsyncClient):
        raise WebSearchError("Web search is not ready", 503)
    upstream = httpx.URL(settings.litellm.upstream_url).copy_with(
        path=settings.litellm.upstream_root_path.rstrip("/") + "/v1/chat/completions"
    )
    try:
        # Covers identity provisioning, connection acquisition, and the complete
        # response body, not just time between individual upstream chunks.
        async with asyncio.timeout(settings.web_search.timeout_seconds):
            api_key = await authenticated_upstream_key(request.scope, settings.litellm, user)
            headers = {
                "x-litellm-end-user-id": str(user.user_team_id),
                "x-request-id": payload["metadata"]["request_id"],
            }
            if api_key:
                headers["Authorization"] = f"Bearer {api_key}"
            async with client.stream(
                "POST",
                upstream,
                json=payload,
                headers=headers,
                timeout=settings.web_search.timeout_seconds,
                follow_redirects=False,
            ) as response:
                return await _read_completion(response)
    except LiteLLMIdentityError as exc:
        raise WebSearchError("LiteLLM search identity is unavailable", exc.status_code) from exc
    except (TimeoutError, httpx.TimeoutException) as exc:
        raise WebSearchError("Web search timed out", 504) from exc
    except (httpx.HTTPError, ValueError) as exc:
        raise WebSearchError("Web search is temporarily unavailable") from exc


async def search_web(
    request: Request, user: AuthenticatedUser, settings: Settings, search: WebSearchRequest
) -> WebSearchResponse:
    policy = settings.web_search
    model = _selected_model(search, policy)
    result = await _complete(request, user, settings, _payload(search, policy, model, user))
    normalized = _normalize(
        result,
        model,
        min(search.max_sources or policy.max_sources, policy.max_sources),
        min(search.max_result_characters or policy.max_result_characters, policy.max_result_characters),
    )
    if policy.require_grounding and not normalized.grounded:
        raise WebSearchError("Search returned no grounding evidence; check LiteLLM's Vertex model and metadata support")
    return normalized
