"""Shared abstract base for application database models."""

from typing import Any

from tortoise import Model
from tortoise.models import ModelMeta

from app.core.config import DATABASE_TABLE_PREFIX


class PrefixedModelMeta(ModelMeta):
    """Ensure every concrete application model uses the project table prefix."""

    def __new__(
        cls,
        name: str,
        bases: tuple[type, ...],
        attrs: dict[str, Any],
    ) -> "PrefixedModelMeta":
        meta_class = attrs.get("Meta")
        is_abstract = bool(meta_class and getattr(meta_class, "abstract", False))

        if not is_abstract:
            if meta_class is None:
                meta_class = type("Meta", (), {})

            table_name = getattr(meta_class, "table", name.lower())
            if not table_name.startswith(DATABASE_TABLE_PREFIX):
                meta_class.table = f"{DATABASE_TABLE_PREFIX}{table_name}"
            attrs["Meta"] = meta_class

        return super().__new__(cls, name, bases, attrs)


class BaseModel(Model, metaclass=PrefixedModelMeta):
    """Abstract base that keeps common model behavior centralized."""

    class Meta:
        abstract = True
