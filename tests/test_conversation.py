from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest

from exporter.conversation import ConversationError, build_active_path, parse_conversation
from exporter.markdown import render_markdown


FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"


class ConversationTests(unittest.TestCase):
    def test_current_node_selects_only_new_branch(self) -> None:
        payload = json.loads((FIXTURES / "branch.json").read_text(encoding="utf-8"))
        document = parse_conversation(payload)
        self.assertEqual([message.body for message in document.messages], ["A user", "B2 assistant-new", "D user", "E assistant"])
        markdown = render_markdown(document)
        self.assertIn("B2 assistant-new", markdown)
        self.assertNotIn("B assistant-old", markdown)
        self.assertNotIn("C old branch", markdown)
        self.assertEqual(document.stats.excluded_branch_nodes, 2)

    def test_no_branch_and_empty_node(self) -> None:
        payload = {
            "title": "No branch",
            "current_node": "b",
            "mapping": {
                "root": {"id": "root", "parent": None, "children": ["a"], "message": None},
                "a": {"id": "a", "parent": "root", "children": ["b"], "message": {"author": {"role": "user"}, "content": {"parts": ["one"]}}},
                "b": {"id": "b", "parent": "a", "children": [], "message": {"author": {"role": "assistant"}, "content": {"parts": ["two"]}}},
            },
        }
        document = parse_conversation(payload)
        self.assertEqual([message.body for message in document.messages], ["one", "two"])
        self.assertEqual(document.stats.skipped_empty_or_metadata_nodes, 1)

    def test_unicode_multiline_code_and_long_text_are_not_truncated(self) -> None:
        long_text = "长文本🙂\n```python\n" + ("print('x')\n" * 5000) + "```"
        payload = {
            "title": "中文标题",
            "conversation_id": "unicode-id",
            "current_node": "assistant",
            "mapping": {
                "root": {"parent": None, "message": None},
                "user": {"parent": "root", "message": {"author": {"role": "user"}, "content": {"parts": ["你好\n世界\n", "🌙"]}}},
                "assistant": {"parent": "user", "message": {"author": {"role": "assistant"}, "content": {"parts": [long_text]}}},
            },
        }
        document = parse_conversation(payload)
        markdown = render_markdown(document)
        self.assertIn("你好\n世界\n🌙", markdown)
        self.assertIn("```python\n", markdown)
        self.assertIn("print('x')\n" * 5000, markdown)

    def test_internal_node_is_not_rendered_but_raw_is_untouched(self) -> None:
        payload = {
            "title": "Internal",
            "current_node": "a",
            "mapping": {
                "root": {"parent": None, "message": None},
                "a": {"parent": "root", "message": {"author": {"role": "assistant"}, "content": {"content_type": "thoughts", "parts": ["hidden"]}}},
            },
        }
        document = parse_conversation(payload)
        self.assertEqual(document.messages, ())
        self.assertEqual(document.raw_payload, payload)
        self.assertEqual(document.stats.skipped_internal_nodes, 1)

    def test_cycle_and_missing_parent_are_errors(self) -> None:
        cycle = {"current_node": "a", "mapping": {"a": {"parent": "b"}, "b": {"parent": "a"}}}
        missing = {"current_node": "a", "mapping": {"a": {"parent": "missing"}}}
        with self.assertRaises(ConversationError):
            build_active_path(cycle)
        with self.assertRaises(ConversationError):
            build_active_path(missing)

    def test_explicit_pagination_is_not_marked_success(self) -> None:
        payload = {
            "title": "Partial",
            "has_more_messages": True,
            "current_node": "a",
            "mapping": {"a": {"parent": None, "message": {"author": {"role": "user"}, "content": {"parts": ["x"]}}}},
        }
        document = parse_conversation(payload)
        self.assertEqual(document.stats.status, "incomplete")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "partial.raw.json"
            path.write_text(json.dumps(payload), encoding="utf-8")
            self.assertEqual(__import__("exporter.convert", fromlist=["main"]).main([str(path)]), 3)
            self.assertFalse(path.with_name("partial.md").exists())
