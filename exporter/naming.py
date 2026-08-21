"""Safe, deterministic filenames and non-destructive output delivery."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence


_CONTROL_OR_SEPARATOR_RE = re.compile(r"[\x00-\x1f\x7f/\\]")
_WINDOWS_FORBIDDEN_RE = re.compile(r"[<>:\"|?*]")
_LOCAL_CONFIG_PATH = Path(__file__).resolve().parent.parent / "extension" / "naming.local.json"


@dataclass(frozen=True)
class SeriesNamingRule:
    pattern: re.Pattern[str]
    filename_prefix: str
    minimum_digits: int = 3


def compile_series_rules(raw_rules: Any) -> tuple[SeriesNamingRule, ...]:
    """Compile optional title-to-number rules from a JSON-compatible value."""
    if not isinstance(raw_rules, list):
        return ()
    compiled: list[SeriesNamingRule] = []
    for raw_rule in raw_rules:
        if not isinstance(raw_rule, dict):
            continue
        pattern = raw_rule.get("title_pattern")
        prefix = raw_rule.get("filename_prefix")
        minimum_digits = raw_rule.get("minimum_digits", 3)
        if not isinstance(pattern, str) or not pattern:
            continue
        if not isinstance(prefix, str) or not prefix:
            continue
        if isinstance(minimum_digits, bool) or not isinstance(minimum_digits, int):
            continue
        if minimum_digits < 1 or minimum_digits > 12:
            continue
        try:
            regex = re.compile(pattern)
        except re.error:
            continue
        if regex.groups < 1:
            continue
        compiled.append(SeriesNamingRule(regex, prefix, minimum_digits))
    return tuple(compiled)


def load_local_naming_rules(path: Path | None = None) -> tuple[SeriesNamingRule, ...]:
    """Load an optional ignored local naming override; missing means generic naming."""
    config_path = path or _LOCAL_CONFIG_PATH
    if not config_path.is_file():
        return ()
    try:
        with config_path.open("r", encoding="utf-8") as handle:
            config = json.load(handle)
    except (OSError, json.JSONDecodeError):
        return ()
    return compile_series_rules(config.get("series_rules") if isinstance(config, dict) else None)


def _matching_series_rule(title: object, rules: Sequence[SeriesNamingRule] | None = None) -> tuple[SeriesNamingRule, int] | None:
    if not isinstance(title, str):
        return None
    active_rules = load_local_naming_rules() if rules is None else rules
    for rule in active_rules:
        match = rule.pattern.fullmatch(title)
        if not match:
            continue
        try:
            return rule, int(match.group(1))
        except (IndexError, TypeError, ValueError):
            continue
    return None


def formal_title_number(title: object, *, rules: Sequence[SeriesNamingRule] | None = None) -> int | None:
    match = _matching_series_rule(title, rules)
    return match[1] if match else None


def sanitize_title(title: object, *, fallback: str = "conversation") -> str:
    value = title if isinstance(title, str) else ""
    value = _CONTROL_OR_SEPARATOR_RE.sub("_", value)
    value = _WINDOWS_FORBIDDEN_RE.sub("_", value)
    value = re.sub(r"\s+", " ", value).strip(" .")
    if value in {"", ".", ".."}:
        value = fallback
    # Keep names portable without making the common case unreadable.
    if len(value) > 180:
        value = f"{value[:160].rstrip()}-long-title"
    return value


def filename_stem(
    title: object,
    conversation_id: object = None,
    *,
    rules: Sequence[SeriesNamingRule] | None = None,
) -> str:
    match = _matching_series_rule(title, rules)
    if match is not None:
        rule, number = match
        prefix = sanitize_title(rule.filename_prefix, fallback="conversation")
        width = max(rule.minimum_digits, len(str(number)))
        return f"{prefix}{number:0{width}d}"
    fallback = sanitize_title(conversation_id, fallback="conversation") if conversation_id else "conversation"
    return sanitize_title(title, fallback=fallback)


def output_filenames(
    title: object,
    conversation_id: object = None,
    *,
    rules: Sequence[SeriesNamingRule] | None = None,
) -> tuple[str, str]:
    stem = filename_stem(title, conversation_id, rules=rules)
    return f"{stem}.raw.json", f"{stem}.md"


def conflict_path(path: Path) -> Path:
    candidate = Path(str(path) + ".new")
    index = 2
    while candidate.exists():
        candidate = Path(str(path) + f".new{index}")
        index += 1
    return candidate
