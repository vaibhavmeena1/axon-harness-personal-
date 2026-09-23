"""Application lifecycle listener registration."""

from collections.abc import Awaitable, Callable
from typing import Literal, TypeAlias

from fastapi import FastAPI

from app.listeners.database import close_database, initialize_database
from app.listeners.litellm import close_litellm_proxy, initialize_litellm_proxy
from app.listeners.openrouter import close_openrouter_client, initialize_openrouter_client

LifespanHook: TypeAlias = Callable[[FastAPI], Awaitable[None]]
LifespanRegistration: TypeAlias = tuple[LifespanHook, Literal["startup", "shutdown"]]

LIFESPANS: list[LifespanRegistration] = [
    (initialize_database, "startup"),
    (close_database, "shutdown"),
    (initialize_litellm_proxy, "startup"),
    (close_litellm_proxy, "shutdown"),
    (initialize_openrouter_client, "startup"),
    (close_openrouter_client, "shutdown"),
]
