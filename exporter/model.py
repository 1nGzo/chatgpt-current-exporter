"""Platform-neutral conversation model used by shared renderers."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class NormalizedMessage:
    sequence: int
    role: str
    text: str
    timestamp: Any = None
    platform_message_id: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class NormalizedConversation:
    platform: str
    conversation_id: str | None
    title: str
    source_url: str = "(unavailable)"
    captured_at: str | None = None
    messages: tuple[NormalizedMessage, ...] = ()
    metadata: dict[str, Any] = field(default_factory=dict)


def normalize_chatgpt(document: Any, *, source_url: str = "(unavailable)", captured_at: str | None = None) -> NormalizedConversation:
    """Adapt the established ChatGPT document without changing its raw payload."""
    messages = tuple(
        NormalizedMessage(
            sequence=index,
            role=message.role,
            text=message.body,
            timestamp=message.create_time,
            platform_message_id=message.message_id,
            metadata={
                "node_id": message.node_id,
                "active_path_index": message.active_path_index,
                "message_id_source": message.message_id_source,
                "update_time": message.update_time,
            },
        )
        for index, message in enumerate(document.messages)
    )
    return NormalizedConversation(
        platform="chatgpt",
        conversation_id=document.conversation_id,
        title=document.title,
        source_url=source_url,
        captured_at=captured_at,
        messages=messages,
        metadata={"mapping_nodes": document.stats.mapping_nodes, "active_path_nodes": document.stats.active_path_nodes},
    )


def detect_platform(raw_payload: Any) -> str:
    """Detect explicit exporter metadata, with legacy ChatGPT schema fallback."""
    if isinstance(raw_payload, dict):
        metadata = raw_payload.get("exporter_metadata")
        if isinstance(metadata, dict) and isinstance(metadata.get("platform"), str):
            return metadata["platform"]
        candidate = raw_payload.get("conversation") if isinstance(raw_payload.get("conversation"), dict) else raw_payload
        if isinstance(candidate, dict) and isinstance(candidate.get("mapping"), dict):
            return "chatgpt"
    return "unknown"
