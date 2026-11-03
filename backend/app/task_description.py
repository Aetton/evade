"""Serialize task descriptions for EvaTeam's HTML field."""
import re

from markdown_it import MarkdownIt

# Stored EvaTeam rich text starts with an element. Tags mentioned inside prose
# or fenced code must still be treated as Markdown text.
_HTML = re.compile(
    r"^\s*<(?:p|div|section|article|h[1-6]|ul|ol|li|table|pre|blockquote|hr|br|"
    r"strong|b|em|i|span|u|s|del|code|a|img|figure)(?=[\s/>])[^>]*>", re.I
)
_MARKDOWN = MarkdownIt("commonmark", {"html": False, "breaks": True}).enable(["table", "strikethrough"])


def eva_description(value: str) -> str:
    if not value or _HTML.match(value):
        return value
    return _MARKDOWN.render(value).rstrip("\n")
