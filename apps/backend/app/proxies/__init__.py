"""Reverse-proxy application registration."""

from app.proxies.litellm import mount_litellm_proxy
from app.proxies.litellm_ui import mount_litellm_ui_proxy

__all__ = ["mount_litellm_proxy", "mount_litellm_ui_proxy"]
