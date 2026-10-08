"""Non-secret preferences for the standalone LiteLLM web-search extension.

These configure the managed client, not a server-side authorization boundary.
LiteLLM owns model access, budgets, and rate limits; the launcher pins routing.
"""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class CliWebSearchConfig(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid", populate_by_name=True)

    enabled: bool
    model: str
    allowed_models: tuple[str, ...] = Field(alias="allowedModels")
    timeout_ms: int = Field(alias="timeoutMs")
    max_query_characters: int = Field(alias="maxQueryCharacters")
    max_result_characters: int = Field(alias="maxResultCharacters")
    max_output_tokens: int = Field(alias="maxOutputTokens")
    max_sources: int = Field(alias="maxSources")
    temperature: float
    thinking_level: Literal["low", "medium", "high"] | None = Field(default=None, alias="thinkingLevel")
    search_context_size: Literal["low", "medium", "high"] | None = Field(default=None, alias="searchContextSize")
    use_url_context: bool = Field(alias="useUrlContext")
    require_grounding: bool = Field(alias="requireGrounding")


class WebSearchSettings(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid", strict=True)

    enabled: bool = Field(default=False, alias="ENABLED")
    model: str = Field(default="gemini-3.8-flash", alias="MODEL", min_length=1, max_length=256, pattern=r"^\S+$")
    allowed_models: list[str] = Field(default_factory=list, alias="ALLOWED_MODELS", max_length=32)
    timeout_seconds: int = Field(default=60, alias="TIMEOUT_SECONDS", ge=1, le=300)
    max_query_characters: int = Field(default=20000, alias="MAX_QUERY_CHARACTERS", ge=1, le=100000)
    max_result_characters: int = Field(default=30000, alias="MAX_RESULT_CHARACTERS", ge=1, le=100000)
    max_output_tokens: int = Field(default=8192, alias="MAX_OUTPUT_TOKENS", ge=1, le=65536)
    temperature: float = Field(default=1, alias="TEMPERATURE", ge=0, le=2, allow_inf_nan=False)
    thinking_level: Literal["low", "medium", "high"] | None = Field(default=None, alias="THINKING_LEVEL")
    # LiteLLM accepts this unified option, but Gemini currently ignores it.
    search_context_size: Literal["low", "medium", "high"] | None = Field(default=None, alias="SEARCH_CONTEXT_SIZE")
    max_sources: int = Field(default=20, alias="MAX_SOURCES", ge=1, le=100)
    use_url_context: bool = Field(default=False, alias="USE_URL_CONTEXT")
    require_grounding: bool = Field(default=True, alias="REQUIRE_GROUNDING")

    def cli_config(self) -> CliWebSearchConfig:
        # Never expose upstream URLs, headers, identity, or credentials.
        return CliWebSearchConfig(
            enabled=self.enabled,
            model=self.model,
            allowed_models=tuple(dict.fromkeys([self.model, *self.allowed_models])),
            timeout_ms=self.timeout_seconds * 1000,
            max_query_characters=self.max_query_characters,
            max_result_characters=self.max_result_characters,
            max_output_tokens=self.max_output_tokens,
            max_sources=self.max_sources,
            temperature=self.temperature,
            thinking_level=self.thinking_level,
            search_context_size=self.search_context_size,
            use_url_context=self.use_url_context,
            require_grounding=self.require_grounding,
        )


def parse_web_search(raw: dict[str, object]) -> WebSearchSettings:
    section = raw.get("WEB_SEARCH", {})
    if not isinstance(section, dict):
        raise ValueError("WEB_SEARCH must be an object")
    settings = WebSearchSettings.model_validate(section)
    if any(not model or len(model) > 256 or any(char.isspace() for char in model) for model in settings.allowed_models):
        raise ValueError("Invalid allowed search model")
    return settings
