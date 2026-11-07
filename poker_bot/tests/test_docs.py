"""README.md's GameStateView tables list exactly what a bot can read."""

import os
import re

from game_state import GameStateView

README = os.path.join(os.path.dirname(__file__), "..", "README.md")


def _documented_names() -> set[str]:
    """Names in the first column of the GameStateView section's tables."""
    text = open(README, encoding="utf-8").read()
    section = text.split("### `GameStateView`", 1)[1].split("\n### ", 1)[0]
    names = set()
    for line in section.splitlines():
        if line.startswith("| `"):
            first_column = line.split("|")[1]
            names |= set(re.findall(r"`(\w+)", first_column))
    return names


def test_readme_lists_every_public_name():
    missing = GameStateView.PUBLIC - _documented_names()
    assert not missing, f"add to README.md's GameStateView tables: {missing}"


def test_readme_lists_only_public_names():
    extra = _documented_names() - GameStateView.PUBLIC
    assert not extra, f"not readable by bots, remove from README.md: {extra}"
