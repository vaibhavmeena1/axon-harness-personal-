"""API and domain schemas for task-based model recommendations."""

from pydantic import BaseModel, ConfigDict, Field, field_validator


class AvailableModel(BaseModel):
    """Model metadata supplied by a coding harness for the current session."""

    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    provider: str = Field(min_length=1)
    id: str = Field(min_length=1)
    name: str | None = None
    reasoning: bool = False
    input_modalities: list[str] = Field(default_factory=list, alias="input")
    context_window: int = Field(default=1, ge=1, alias="contextWindow")

    @property
    def key(self) -> str:
        """Return the provider-qualified model identifier used by Pi."""
        return f"{self.provider}/{self.id}"

    @property
    def accepts_images(self) -> bool:
        """Return whether this model accepts image input."""
        return "image" in self.input_modalities


class ConfiguredModel(BaseModel):
    """A controlled model capability profile used by recommendation policy."""

    model_config = ConfigDict(populate_by_name=True)

    provider: str = Field(min_length=1)
    id: str = Field(min_length=1)
    enabled: bool = True
    quality: float = Field(ge=0, le=1)
    reasoning: float = Field(ge=0, le=1)
    speed: float = Field(ge=0, le=1)
    input_modalities: list[str] = Field(default_factory=list, alias="input")

    @property
    def key(self) -> str:
        """Return the exact provider-qualified identifier expected from Pi."""
        return f"{self.provider}/{self.id}"

    @property
    def accepts_images(self) -> bool:
        """Return whether policy permits this model for image input."""
        return "image" in self.input_modalities


class ModelCatalog(BaseModel):
    """Controlled recommendation activation and candidate-model policy."""

    model_config = ConfigDict(populate_by_name=True)

    enabled_for_current_models: list[str] = Field(
        default_factory=list,
        alias="enabledForCurrentModels",
    )
    models: list[ConfiguredModel]


class ModelRecommendationRequest(BaseModel):
    """A user task and the models that the current Pi session can use."""

    model_config = ConfigDict(populate_by_name=True)

    prompt: str = Field(min_length=1, max_length=100_000)
    has_images: bool = Field(default=False, alias="hasImages")
    current_model: str | None = Field(default=None, alias="currentModel")
    available_models: list[AvailableModel] = Field(
        min_length=1,
        max_length=250,
        alias="availableModels",
    )
    limit: int = Field(default=4, ge=1, le=8)

    @field_validator("prompt")
    @classmethod
    def validate_prompt(cls, value: str) -> str:
        """Reject prompts that contain only whitespace."""
        if not value.strip():
            raise ValueError("prompt must contain non-whitespace text")
        return value


class ModelRecommendation(BaseModel):
    """One compatible model ranked for the submitted task."""

    provider: str
    id: str
    confidence: float = Field(ge=0, le=1)
    reason: str


class TaskAssessment(BaseModel):
    """Jev judgments retained for observability and policy tuning."""

    model_config = ConfigDict(populate_by_name=True)

    complexity: float = Field(ge=0, le=3)
    complexity_confidence: float = Field(ge=0, le=1, alias="complexityConfidence")
    high_complexity_probability: float = Field(
        ge=0,
        le=1,
        alias="highComplexityProbability",
    )
    needs_deep_reasoning: float = Field(ge=0, le=1, alias="needsDeepReasoning")
    prioritizes_speed: float = Field(ge=0, le=1, alias="prioritizesSpeed")


class ModelRecommendationResponse(BaseModel):
    """Ranked compatible models and the Jev assessment behind the ranking."""

    recommendations: list[ModelRecommendation]
    assessment: TaskAssessment
