"""Database startup and shutdown listeners."""

import logging

from fastapi import FastAPI
from tortoise import Tortoise

from app.core.config import get_settings

logger = logging.getLogger(__name__)


async def initialize_database(app: FastAPI) -> None:
    """Initialize Tortoise, create the asyncpg pool, and fail fast on connectivity."""
    settings = get_settings()
    await Tortoise.init(
        config=settings.database.tortoise_config(),
        _enable_global_fallback=True,
    )

    database = Tortoise.get_connection("default")
    await database.execute_query("SELECT 1")
    app.state.database = database
    logger.info("Database connection pool initialized")


async def close_database(app: FastAPI) -> None:
    """Close all Tortoise-managed database connections."""
    await Tortoise.close_connections()
    app.state.database = None
    logger.info("Database connection pool closed")
