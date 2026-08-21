"""Parse a single ChatGPT conversation without changing the raw payload.

The parser intentionally treats ``mapping`` and ``current_node`` as the
source of truth.  It never sorts nodes by time and never walks sibling
branches while rendering the active conversation.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import json
from pathlib import Path
from typing import Any, Iterable


VISIBLE_ROLES = {"user", "assistant"}
INTERNAL_CONTENT_TYPES = {"thoughts", "reasoning_recap"}


class ConversationError(ValueError):
    """Raised when a payload cannot safely produce an active path."""


@dataclass(frozen=True)
class ActiveNode:
    node_id: str
    node: dict[str, Any]
    index: int


@dataclass(frozen=True)
class VisibleMessage:
    node_id: str
    message_id: str
    message_id_source: str
    active_path_index: int
    role: str
    body: str
    create_time: Any = None
    update_time: Any = None


@dataclass
class ConversationStats:
    mapping_nodes: int = 0
    active_path_nodes: int = 0
    visible_messages: int = 0
    user_messages: int = 0
    assistant_messages: int = 0
    skipped_empty_or_metadata_nodes: int = 0
    skipped_internal_nodes: int = 0
    excluded_branch_nodes: int = 0
    warnings: list[str] = field(default_factory=list)
    incomplete_reasons: list[str] = field(default_factory=list)

    @property
    def status(self) -> str:
        if self.incomplete_reasons:
            return "incomplete"
        if self.warnings:
            return "review"
        return "ready"


@dataclass(frozen=True)
class ConversationDocument:
    """The parsed view of a conversation plus the untouched source payload."""

    raw_payload: Any
    conversation_payload: dict[str, Any]
    title: str
    conversation_id: str | None
    active_path: tuple[ActiveNode, ...]
    messages: tuple[VisibleMessage, ...]
    stats: ConversationStats


def _is_mapping(value: Any) -> bool:
    return isinstance(value, dict) and isinstance(value.get("mapping"), dict)


def _conversation_candidate(value: Any) -> dict[str, Any] | None:
    """Find a conversation-shaped object without recursively scanning content.

    The browser normally captures the direct response.  A few response
    wrappers are accepted so that raw files can preserve the wrapper while the
    parser renders its nested conversation.
    """

    if _is_mapping(value):
        return value
    if not isinstance(value, dict):
        return None
    for key in ("conversation", "data", "item"):
        candidate = value.get(key)
        if _is_mapping(candidate):
            return candidate
    return None


def conversation_candidate(value: Any) -> dict[str, Any]:
    candidate = _conversation_candidate(value)
    if candidate is None:
        raise ConversationError("JSON 中没有找到包含 mapping 的 conversation 对象")
    return candidate


def conversation_id(payload: dict[str, Any]) -> str | None:
    value = payload.get("conversation_id") or payload.get("id")
    return str(value) if value is not None else None


def conversation_title(payload: dict[str, Any]) -> str:
    value = payload.get("title")
    return value if isinstance(value, str) and value.strip() else "Untitled conversation"


def explicit_incompleteness(value: Any) -> list[str]:
    """Return explicit pagination/truncation signals, if the API supplies any.

    Absence of these signals does *not* prove completeness: an undocumented
    endpoint may still return a partial view.  The CLI and extension therefore
    describe capture completeness as unverified unless the payload explicitly
    says it is incomplete.
    """

    candidate = _conversation_candidate(value)
    if candidate is None:
        return []
    reasons: list[str] = []
    for key in ("partial", "is_partial", "truncated", "is_truncated", "has_more", "has_more_messages"):
        if candidate.get(key) is True:
            reasons.append(f"payload.{key}=true")
    for key in ("next_cursor", "next_page", "next_token"):
        if candidate.get(key) not in (None, "", False):
            reasons.append(f"payload.{key} is present")
    pagination = candidate.get("pagination")
    if isinstance(pagination, dict):
        if pagination.get("has_more") is True:
            reasons.append("payload.pagination.has_more=true")
        if pagination.get("next_cursor") not in (None, "", False):
            reasons.append("payload.pagination.next_cursor is present")
    return reasons


def build_active_path(payload: dict[str, Any]) -> tuple[ActiveNode, ...]:
    mapping = payload.get("mapping")
    current = payload.get("current_node")
    if not isinstance(mapping, dict):
        raise ConversationError("mapping 不是对象")
    if current is None or current == "":
        raise ConversationError("缺少 current_node")

    current_id = str(current)
    if current_id not in mapping:
        raise ConversationError(f"current_node 不在 mapping 中：{current_id}")

    reverse: list[tuple[str, dict[str, Any]]] = []
    seen: set[str] = set()
    node_id: str | None = current_id
    while node_id is not None:
        if node_id in seen:
            raise ConversationError(f"parent 链出现循环：{node_id}")
        seen.add(node_id)
        node = mapping.get(node_id)
        if not isinstance(node, dict):
            raise ConversationError(f"mapping 节点不是对象：{node_id}")
        reverse.append((node_id, node))
        parent = node.get("parent")
        if parent is None or parent == "":
            break
        parent_id = str(parent)
        if parent_id not in mapping:
            raise ConversationError(f"parent 节点缺失：{parent_id}（由 {node_id} 指向）")
        node_id = parent_id

    reverse.reverse()
    return tuple(ActiveNode(node_id=node_id, node=node, index=index) for index, (node_id, node) in enumerate(reverse))


def _asset_id(value: Any) -> str | None:
    if not isinstance(value, str) or not value:
        return None
    return value.split("://", 1)[1] if "://" in value else value


def _attachment_index(message: dict[str, Any]) -> dict[str, dict[str, Any]]:
    metadata = message.get("metadata")
    attachments = metadata.get("attachments") if isinstance(metadata, dict) else None
    result: dict[str, dict[str, Any]] = {}
    if isinstance(attachments, list):
        for item in attachments:
            if not isinstance(item, dict):
                continue
            for key in (item.get("id"), item.get("asset_pointer"), item.get("library_file_id")):
                if key:
                    result[str(key)] = item
    return result


def _attachment_placeholder(
    *, kind: str, asset_id: str | None, filename: Any = None, mime_type: Any = None, size: Any = None
) -> str:
    fields = [kind]
    if asset_id:
        fields.append(f"asset_id: {asset_id}")
    if filename:
        fields.append(f"filename: {filename}")
    if mime_type:
        fields.append(f"mime_type: {mime_type}")
    if size is not None:
        fields.append(f"size: {size}")
    return "[" + "｜".join(fields) + "]"


def _json_preview(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _render_part(
    part: Any,
    *,
    attachments: dict[str, dict[str, Any]],
    warnings: list[str],
    message_label: str,
) -> tuple[str, set[str]]:
    if isinstance(part, str):
        return part, set()
    if not isinstance(part, dict):
        warnings.append(f"{message_label} 有未识别的 content part 类型：{type(part).__name__}")
        return f"[非文本内容：{type(part).__name__}]", set()

    # Common structured text variants are preserved verbatim.
    for key in ("text", "value"):
        if isinstance(part.get(key), str):
            return part[key], set()
    nested_content = part.get("content")
    if isinstance(nested_content, str):
        return nested_content, set()

    raw_pointer = part.get("asset_pointer") or part.get("asset_id") or part.get("id")
    asset_id = _asset_id(raw_pointer)
    related = attachments.get(str(raw_pointer), {}) if raw_pointer else {}
    if not related and asset_id:
        related = attachments.get(asset_id, {})
    filename = part.get("name") or related.get("name")
    mime_type = part.get("mime_type") or related.get("mime_type")
    size = part.get("size_bytes") or related.get("size")
    content_type = part.get("content_type")
    if raw_pointer or filename or content_type:
        kind = "图片附件" if content_type == "image_asset_pointer" or (
            isinstance(mime_type, str) and mime_type.startswith("image/")
        ) else "附件"
        return (
            _attachment_placeholder(
                kind=kind,
                asset_id=asset_id or str(raw_pointer) if raw_pointer else None,
                filename=filename,
                mime_type=mime_type,
                size=size,
            ),
            {str(raw_pointer), asset_id} - {None},
        )

    warnings.append(f"{message_label} 有未识别的对象 content part，已保留 JSON 占位符")
    return f"[未识别 content part：{_json_preview(part)}]", set()


def _render_message(node: ActiveNode, stats: ConversationStats) -> VisibleMessage | None:
    message = node.node.get("message")
    if not isinstance(message, dict):
        stats.skipped_empty_or_metadata_nodes += 1
        return None
    author = message.get("author")
    role = author.get("role") if isinstance(author, dict) else None
    content = message.get("content")
    content_type = content.get("content_type") if isinstance(content, dict) else None
    if content_type in INTERNAL_CONTENT_TYPES:
        stats.skipped_internal_nodes += 1
        return None
    if role not in VISIBLE_ROLES:
        stats.skipped_empty_or_metadata_nodes += 1
        if role is not None:
            stats.warnings.append(f"active path 上跳过不可见 role：{role}")
        return None

    attachments = _attachment_index(message)
    pieces: list[str] = []
    seen_assets: set[str] = set()
    label = f"node {node.node_id}"
    if isinstance(content, str):
        pieces.append(content)
    elif isinstance(content, dict):
        parts = content.get("parts")
        if isinstance(parts, list):
            for part in parts:
                rendered, assets = _render_part(
                    part, attachments=attachments, warnings=stats.warnings, message_label=label
                )
                pieces.append(rendered)
                seen_assets.update(assets)
        elif isinstance(parts, str):
            pieces.append(parts)
        elif isinstance(content.get("text"), str):
            pieces.append(content["text"])
        elif parts is not None:
            stats.warnings.append(f"{label} 的 content.parts 类型异常：{type(parts).__name__}")
        elif content:
            stats.warnings.append(f"{label} 没有可识别的文本 parts")
    elif content is not None:
        stats.warnings.append(f"{label} 的 content 类型异常：{type(content).__name__}")

    # Some file attachments exist only in message.metadata.attachments.
    appended: set[str] = set()
    for attachment_key, attachment in attachments.items():
        canonical_id = str(attachment.get("id") or attachment.get("library_file_id") or attachment_key)
        if canonical_id in appended:
            continue
        appended.add(canonical_id)
        if canonical_id in seen_assets or attachment_key in seen_assets:
            continue
        filename = attachment.get("name")
        mime_type = attachment.get("mime_type")
        kind = "图片附件" if isinstance(mime_type, str) and mime_type.startswith("image/") else "附件"
        pieces.append(
            _attachment_placeholder(
                kind=kind,
                asset_id=str(attachment.get("id") or attachment_key),
                filename=filename,
                mime_type=mime_type,
                size=attachment.get("size"),
            )
        )

    body = "".join(pieces)
    if body == "":
        stats.skipped_empty_or_metadata_nodes += 1
        stats.warnings.append(f"{label} 是空的可见消息，未写入 Markdown")
        return None

    message_id_value = message.get("id")
    message_id = str(message_id_value if message_id_value is not None else node.node_id)
    if message_id_value is None:
        stats.warnings.append(f"{label} 缺少 message.id，使用 mapping 节点 id")
    return VisibleMessage(
        node_id=node.node_id,
        message_id=message_id,
        message_id_source="message.id" if message_id_value is not None else "mapping.node.id",
        active_path_index=node.index,
        role=str(role),
        body=body,
        create_time=message.get("create_time"),
        update_time=message.get("update_time"),
    )


def parse_conversation(value: Any) -> ConversationDocument:
    raw_payload = value
    payload = conversation_candidate(value)
    mapping = payload["mapping"]
    path = build_active_path(payload)
    stats = ConversationStats(
        mapping_nodes=len(mapping),
        active_path_nodes=len(path),
        excluded_branch_nodes=max(0, len(mapping) - len(path)),
    )
    stats.incomplete_reasons.extend(explicit_incompleteness(value))
    messages: list[VisibleMessage] = []
    for node in path:
        message = _render_message(node, stats)
        if message is not None:
            messages.append(message)
    stats.visible_messages = len(messages)
    stats.user_messages = sum(message.role == "user" for message in messages)
    stats.assistant_messages = sum(message.role == "assistant" for message in messages)
    return ConversationDocument(
        raw_payload=raw_payload,
        conversation_payload=payload,
        title=conversation_title(payload),
        conversation_id=conversation_id(payload),
        active_path=path,
        messages=tuple(messages),
        stats=stats,
    )


def load_json(path: Path) -> Any:
    try:
        with path.open("r", encoding="utf-8") as handle:
            return json.load(handle)
    except json.JSONDecodeError as exc:
        raise ConversationError(f"JSON 解析失败：{path}（{exc}）") from exc
    except OSError as exc:
        raise ConversationError(f"无法读取输入文件：{path}（{exc}）") from exc
