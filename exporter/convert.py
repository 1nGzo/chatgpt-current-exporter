"""CLI: convert one local ``*.raw.json`` into active-path Markdown."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

from .conversation import ConversationError, load_json, parse_conversation
from .markdown import render_markdown
from .naming import conflict_path


def _default_output(path: Path) -> Path:
    suffix = ".raw.json"
    if path.name.endswith(suffix):
        return path.with_name(path.name[: -len(suffix)] + ".md")
    return path.with_suffix(".md")


def _write_output(path: Path, content: str, *, force: bool, use_new: bool) -> tuple[Path, str]:
    encoded = content.encode("utf-8")
    if path.exists():
        if path.is_file() and path.read_bytes() == encoded:
            return path, "unchanged"
        if force:
            path.write_bytes(encoded)
            return path, "overwritten"
        if use_new:
            path = conflict_path(path)
        else:
            raise ConversationError(
                f"输出文件已存在且内容不同，未覆盖：{path}；可使用 --new 或 --force"
            )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(encoded)
    return path, "created"


def _print_summary(input_path: Path, output_path: Path | None, document, *, verbose: bool) -> None:
    stats = document.stats
    print(f"input: {input_path}")
    print(f"title: {document.title}")
    print(f"conversation_id: {document.conversation_id or '(missing)'}")
    print(f"mapping nodes: {stats.mapping_nodes}")
    print(f"active path nodes: {stats.active_path_nodes}")
    print(f"user messages: {stats.user_messages}")
    print(f"assistant messages: {stats.assistant_messages}")
    print(f"status: {stats.status} (payload completeness is not independently provable)")
    if output_path is not None:
        print(f"output: {output_path}")
        print(f"size: {output_path.stat().st_size} bytes")
    if verbose:
        print(f"excluded branch nodes: {stats.excluded_branch_nodes}")
        print(f"active path visible messages: {stats.visible_messages}")
        for warning in stats.warnings:
            print(f"warning: {warning}")
        for reason in stats.incomplete_reasons:
            print(f"incomplete: {reason}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Convert a single ChatGPT raw JSON to active-path Markdown.")
    parser.add_argument("input", type=Path, help="conversation raw JSON")
    parser.add_argument("--output", type=Path, help="Markdown output path; defaults beside input")
    parser.add_argument("--force", action="store_true", help="explicitly overwrite a different existing output")
    parser.add_argument("--new", action="store_true", help="write .new/.new2 on conflict")
    parser.add_argument("--verbose", action="store_true", help="print warnings and detailed diagnostics")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    input_path = args.input.expanduser().resolve()
    try:
        document = parse_conversation(load_json(input_path))
        if document.stats.incomplete_reasons:
            _print_summary(input_path, None, document, verbose=True)
            print("ERROR: payload explicitly indicates pagination/truncation; Markdown was not generated.", file=sys.stderr)
            return 3
        if not document.messages:
            raise ConversationError("active path 上没有可导出的 user/assistant 可见消息")
        output_path = (args.output or _default_output(input_path)).expanduser().resolve()
        written_path, action = _write_output(
            output_path, render_markdown(document), force=args.force, use_new=args.new
        )
        _print_summary(input_path, written_path, document, verbose=args.verbose)
        print(f"delivery: {action}")
        return 0
    except ConversationError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    except OSError as exc:
        print(f"ERROR: output failed: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
