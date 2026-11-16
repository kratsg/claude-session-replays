"""Unit tests for skills/session-replay/scripts/extract_session.py."""

import json

import extract_session
import pytest


def user_row(content, **extra):
    return {
        "type": "user",
        "timestamp": "2026-11-15T12:00:00Z",
        "message": {"role": "user", "content": content},
        **extra,
    }


@pytest.fixture
def redact():
    return extract_session.make_redactor(extract_session.compile_rules(None))


class TestInjectedUserRecords:
    def test_typed_prompt_is_kept(self):
        events = extract_session.extract([user_row("fix the bug")], {}, None)
        assert [(e["kind"], e["text"]) for e in events] == [("prompt", "fix the bug")]

    def test_harness_injected_skill_text_is_not_a_prompt(self):
        rows = [
            user_row("fix the bug"),
            user_row("Base directory for this skill: ...", isMeta=True),
        ]
        events = extract_session.extract(rows, {}, None)
        assert [e["text"] for e in events if e["kind"] == "prompt"] == ["fix the bug"]


class TestEmailDefault:
    def test_other_peoples_email_gets_a_neutral_placeholder(self, redact):
        assert redact("rotated by priya@corp.example.net") == (
            "rotated by someone@example.org"
        )

    def test_local_pattern_for_the_users_own_email_wins(self, tmp_path):
        local = tmp_path / "local-redact.json"
        local.write_text(
            json.dumps({"patterns": [["me@uni\\.edu", "jovyan@example.org"]]})
        )
        redact = extract_session.make_redactor(extract_session.compile_rules(local))
        assert redact("me@uni.edu and you@uni.edu") == (
            "jovyan@example.org and someone@example.org"
        )


class TestTempPaths:
    @pytest.mark.parametrize(
        ("raw", "masked"),
        [
            (
                "/private/tmp/claude-501/proj/0f3a/scratchpad/demo/test_wordfreq.py:12",
                "/tmp/scratch/test_wordfreq.py:12",
            ),
            ("/var/folders/ab/xyz/T/report.json", "/tmp/scratch/report.json"),
            ("/tmp/claude-501/proj/session/notes.md", "/tmp/scratch/notes.md"),
            ("cd /private/tmp/claude-501/proj/0f3a/scratchpad/demo", "cd /tmp/scratch"),
        ],
    )
    def test_directories_are_masked_but_file_names_kept(self, redact, raw, masked):
        assert redact(raw) == masked


class TestHomePaths:
    def test_macos_home_becomes_jovyan(self, redact):
        assert redact("/Users/alice/work/x.py") == "/home/jovyan/work/x.py"
