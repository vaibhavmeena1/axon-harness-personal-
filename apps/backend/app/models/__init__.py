"""Tortoise model discovery package."""

from app.models.base import BaseModel
from app.models.session_backup import SessionBackup

__all__ = ["BaseModel", "SessionBackup"]
