"""ChatGPT adapter preserving the established mapping parser."""

from __future__ import annotations

from typing import Any

from ..conversation import ConversationDocument, parse_conversation


platform = "chatgpt"


def can_handle(raw_payload: Any) -> bool:
    if not isinstance(raw_payload, dict):
        return False
    candidate = raw_payload.get("conversation") if isinstance(raw_payload.get("conversation"), dict) else raw_payload
    return isinstance(candidate, dict) and isinstance(candidate.get("mapping"), dict)


def parse(raw_payload: Any) -> ConversationDocument:
    return parse_conversation(raw_payload)
