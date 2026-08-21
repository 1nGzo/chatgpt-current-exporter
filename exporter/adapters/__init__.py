"""Platform adapter registry for the Python conversion boundary."""

from __future__ import annotations

from typing import Any

from ..conversation import ConversationDocument
from . import chatgpt, gemini


def select_adapter(raw_payload: Any):
    if gemini.can_handle(raw_payload):
        return gemini
    return chatgpt


def parse_with_adapter(raw_payload: Any) -> ConversationDocument:
    adapter = select_adapter(raw_payload)
    return adapter.parse(raw_payload)


__all__ = ["chatgpt", "gemini", "parse_with_adapter", "select_adapter"]
