from __future__ import annotations

import unittest

from exporter.naming import compile_series_rules, filename_stem, output_filenames, sanitize_title


class NamingTests(unittest.TestCase):
    def test_configured_series_title_is_zero_padded(self) -> None:
        rules = compile_series_rules([
            {
                "title_pattern": r"^Series ([0-9]+)$",
                "filename_prefix": "Conversation",
                "minimum_digits": 3,
            }
        ])
        self.assertEqual(filename_stem("Series 64", rules=rules), "Conversation064")
        self.assertEqual(output_filenames("Series 64", rules=rules), ("Conversation064.raw.json", "Conversation064.md"))

    def test_unsafe_title_is_sanitized(self) -> None:
        value = sanitize_title(" a/b\\c\x00\n<>:" )
        self.assertNotRegex(value, r"[/\\\x00-\x1f\x7f<>:\"|?*]")
        self.assertNotIn(value, {"", ".", ".."})

    def test_fallback_and_long_title(self) -> None:
        self.assertEqual(filename_stem("", "abc"), "abc")
        self.assertLessEqual(len(sanitize_title("x" * 500)), 180)
