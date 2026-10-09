"""Visible application diagnostics without enabling verbose HTTP client logs."""

import logging


def configure_application_logging() -> None:
    """Supply a console default only when deployment logging has no handler.

    Uvicorn configures its own loggers, not the app namespace. Do not configure
    the root logger: HTTP client INFO logs can contain credential-bearing URLs.
    """
    logger = logging.getLogger("app")
    if logger.hasHandlers():
        return
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter("%(levelname)s: %(name)s %(message)s"))
    logger.addHandler(handler)
    if logger.level == logging.NOTSET:
        logger.setLevel(logging.INFO)
    logger.propagate = False
