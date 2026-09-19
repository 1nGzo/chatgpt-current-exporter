"""Platform adapter registry for the Python conversion boundary."""

from __future__ import annotations

from typing import Any

from ..conversation import ConversationDocument
from . import chatgpt


def select_adapter(raw_payload: Any):
    return chatgpt


def parse_with_adapter(raw_payload: Any) -> ConversationDocument:
    return select_adapter(raw_payload).parse(raw_payload)


__all__ = ["chatgpt", "parse_with_adapter", "select_adapter"]
