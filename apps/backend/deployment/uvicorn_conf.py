"""Uvicorn process settings loaded from the application config file."""

from app.core.config import get_settings

settings = get_settings()

HOST = settings.host
PORT = settings.port
WORKERS = settings.workers
ACCESS_LOG = settings.access_log
