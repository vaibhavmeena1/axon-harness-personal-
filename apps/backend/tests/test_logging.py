"""Application logging defaults are visible, idempotent, and narrowly scoped."""

import logging

import pytest

from app.core.logging import configure_application_logging


def test_console_logging_default(monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]) -> None:
    logger = logging.Logger("app")
    monkeypatch.setitem(logging.Logger.manager.loggerDict, "app", logger)
    configure_application_logging()
    configure_application_logging()
    assert len(logger.handlers) == 1
    assert logger.level == logging.INFO
    assert not logger.propagate
    logger.info("safe diagnostic")
    assert capsys.readouterr().err == "INFO: app safe diagnostic\n"


def test_existing_deployment_logging_is_preserved(monkeypatch: pytest.MonkeyPatch) -> None:
    parent = logging.Logger("deployment", level=logging.WARNING)
    parent.addHandler(logging.NullHandler())
    logger = logging.Logger("app")
    logger.parent = parent
    monkeypatch.setitem(logging.Logger.manager.loggerDict, "app", logger)
    configure_application_logging()
    assert logger.handlers == []
    assert logger.level == logging.NOTSET
    assert logger.propagate


def test_explicit_app_log_level_is_preserved(monkeypatch: pytest.MonkeyPatch) -> None:
    logger = logging.Logger("app", level=logging.ERROR)
    monkeypatch.setitem(logging.Logger.manager.loggerDict, "app", logger)
    configure_application_logging()
    assert logger.level == logging.ERROR
