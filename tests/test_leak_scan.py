"""Unit tests for skills/session-replay/scripts/leak_scan.py."""

import leak_scan
import pytest

TEXT = "/Users/alice/x.py and ghp_AbCdEfGhIjKlMnOpQrStUv"


@pytest.mark.parametrize("level", ["full", "light"])
def test_full_and_light_flag_identity_and_secrets(level):
    names = {name for name, _ in leak_scan.scan(TEXT, leak_scan.checks_for(level))}
    assert {"macOS home path", "api token"} <= names


def test_none_flags_only_secrets():
    names = {name for name, _ in leak_scan.scan(TEXT, leak_scan.checks_for("none"))}
    assert names == {"api token"}
