"""Deterministic mapping from Jev task judgments to controlled models."""

from app.services.model_recommendation.catalog import get_model_catalog
from app.services.model_recommendation.jev import JevTaskAssessment
from app.services.model_recommendation.schemas import (
    ConfiguredModel,
    ModelRecommendation,
    ModelRecommendationRequest,
)


def rank_available_models(
    request: ModelRecommendationRequest,
    assessment: JevTaskAssessment,
) -> list[ModelRecommendation]:
    """Rank configured models that are available in the caller's Pi session."""
    available_by_key = {model.key: model for model in request.available_models}
    candidates: list[ConfiguredModel] = []

    for model in get_model_catalog().models:
        available_model = available_by_key.get(model.key)
        if not model.enabled or available_model is None:
            continue
        if request.has_images and (not model.accepts_images or not available_model.accepts_images):
            continue
        candidates.append(model)

    if not candidates:
        raise ValueError("No configured compatible model is available to the Pi session")

    complexity = assessment.normalized_complexity
    reasoning_target = max(assessment.needs_deep_reasoning, complexity * 0.85)
    quality_target = _clamp(
        0.2 + complexity * 0.55 + assessment.high_complexity_probability * 0.15 + assessment.needs_deep_reasoning * 0.1
    )
    speed_target = _clamp((1 - complexity) * 0.7 + assessment.prioritizes_speed * 0.3)

    ranked: list[tuple[float, ConfiguredModel]] = []
    for model in candidates:
        distance = (
            abs(model.quality - quality_target) * 0.5625
            + abs(model.reasoning - reasoning_target) * 0.3125
            + abs(model.speed - speed_target) * 0.125
        )
        fit = _clamp(1 - distance)
        if model.key == request.current_model:
            fit = _clamp(fit + 0.015)
        ranked.append((fit, model))

    ranked.sort(key=lambda entry: (-entry[0], entry[1].key))
    return [
        ModelRecommendation(
            provider=model.provider,
            id=model.id,
            confidence=round(
                fit * (0.7 + assessment.complexity_confidence * 0.3),
                4,
            ),
            reason=_reason(model, assessment),
        )
        for fit, model in ranked[: request.limit]
    ]


def _reason(model: ConfiguredModel, assessment: JevTaskAssessment) -> str:
    if assessment.complexity >= 2.25:
        task_fit = "High-complexity task fit"
    elif assessment.complexity >= 1.25:
        task_fit = "Multi-step task fit"
    else:
        task_fit = "Focused task fit"

    traits: list[str] = []
    if model.reasoning >= 0.5 and assessment.needs_deep_reasoning >= 0.5:
        traits.append("reasoning support")
    if model.speed >= 0.7 and (assessment.prioritizes_speed >= 0.5 or assessment.normalized_complexity < 0.4):
        traits.append("fast-model profile")

    return f"{task_fit}; {', '.join(traits)}" if traits else task_fit


def _clamp(value: float) -> float:
    return max(0, min(1, value))
