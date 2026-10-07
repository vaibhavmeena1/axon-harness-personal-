"""Validated static model catalog for controlled recommendation policy."""

from functools import cache
from hashlib import sha256
from pathlib import Path

from pydantic import ValidationError

from app.services.model_recommendation.schemas import ModelCatalog

_MODEL_CATALOG_PATH = Path(__file__).with_name("model_catalog.json")


@cache
def get_model_catalog() -> ModelCatalog:
    """Load the controlled model catalog once per backend process."""
    try:
        catalog = ModelCatalog.model_validate_json(_MODEL_CATALOG_PATH.read_text())
    except (OSError, ValidationError, ValueError) as exc:
        raise RuntimeError(f"Invalid model recommendation catalog at {_MODEL_CATALOG_PATH}") from exc

    model_keys = [model.key for model in catalog.models]
    if len(model_keys) != len(set(model_keys)):
        raise RuntimeError(f"Duplicate model keys in recommendation catalog at {_MODEL_CATALOG_PATH}")
    if len(catalog.enabled_for_current_models) != len(set(catalog.enabled_for_current_models)):
        raise RuntimeError(f"Duplicate activation keys in recommendation catalog at {_MODEL_CATALOG_PATH}")

    return catalog


def model_policy_version() -> str:
    """Content-address the controlled policy, not user input or available-model payloads."""
    return sha256(get_model_catalog().model_dump_json().encode()).hexdigest()[:12]


def is_model_recommendation_enabled(current_model: str | None) -> bool:
    """Return whether policy enables recommendation for the active Pi model."""
    return current_model is not None and current_model in get_model_catalog().enabled_for_current_models
