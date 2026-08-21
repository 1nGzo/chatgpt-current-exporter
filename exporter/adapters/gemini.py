"""Gemini adapter boundary; live schema validation is intentionally pending."""

from __future__ import annotations

from typing import Any

from ..conversation import ConversationError


platform = "gemini"


def can_handle(raw_payload: Any) -> bool:
    if not isinstance(raw_payload, dict):
        return False
    metadata = raw_payload.get("exporter_metadata")
    return isinstance(metadata, dict) and metadata.get("platform") == platform


def parse(raw_payload: Any):
    raise ConversationError("Gemini raw schema 尚未经过 live discovery 验证；未生成 Markdown")
