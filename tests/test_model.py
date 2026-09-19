from __future__ import annotations

import json
from pathlib import Path
import unittest

from exporter.adapters import select_adapter
from exporter.conversation import parse_conversation
from exporter.markdown import render_normalized_markdown
from exporter.model import detect_platform, normalize_chatgpt


FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"


class NormalizedModelTests(unittest.TestCase):
    def test_chatgpt_document_adapts_without_changing_active_path(self) -> None:
        payload = json.loads((FIXTURES / "branch.json").read_text(encoding="utf-8"))
        document = parse_conversation(payload)
        normalized = normalize_chatgpt(document, source_url="https://chatgpt.com/c/fixture", captured_at="2026-01-01T00:00:00Z")
        self.assertEqual(normalized.platform, "chatgpt")
        self.assertEqual([message.text for message in normalized.messages], ["A user", "B2 assistant-new", "D user", "E assistant"])
        self.assertEqual(detect_platform(payload), "chatgpt")
        self.assertIn("B2 assistant-new", render_normalized_markdown(normalized))
        self.assertNotIn("B assistant-old", render_normalized_markdown(normalized))

    def test_explicit_platform_metadata_wins(self) -> None:
        self.assertEqual(detect_platform({"exporter_metadata": {"platform": "grok"}}), "grok")
        self.assertEqual(detect_platform({"title": "plain"}), "unknown")

