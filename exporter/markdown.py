"""Lossless-ish Raw Markdown rendering for a parsed conversation."""

from __future__ import annotations

from .conversation import ConversationDocument, VisibleMessage


def _value(value: object) -> str:
    return "None" if value is None else str(value)


def _render_message(turn: int, message: VisibleMessage) -> str:
    lines = [f"## Turn {turn:04d}｜{message.role.upper()}", "", f"- message_id：{message.message_id}"]
    if message.message_id_source != "message.id":
        lines.append(f"- message_id_source：{message.message_id_source}")
    lines.append(f"- active_path_index：{message.active_path_index}")
    lines.append(f"- create_time：{_value(message.create_time)}")
    if message.update_time is not None:
        lines.append(f"- update_time：{message.update_time}")
    lines.extend(["", message.body, "", "---", ""])
    return "\n".join(lines)

def render_markdown(document: ConversationDocument) -> str:
    """Render only messages on ``document.active_path``.

    The Turn/metadata shape follows the existing local Raw exporter closely,
    while the H1 uses the actual conversation title for a single-conversation
    export.
    """

    stats = document.stats
    lines = [
        f"# {document.title}",
        "",
        f"- conversation_id：{_value(document.conversation_id)}",
        f"- mapping 节点数：{stats.mapping_nodes}",
        f"- active path 节点数：{stats.active_path_nodes}",
        f"- 排除的其他分支节点数：{stats.excluded_branch_nodes}",
        "",
        "---",
        "",
    ]
    lines.extend(_render_message(turn, message) for turn, message in enumerate(document.messages, 1))
    return "\n".join(lines)
