#!/usr/bin/env python3
"""Turn a Claude Code session transcript (JSONL) into a redacted events.json.

The transcript is the file Claude Code writes for every session under
~/.claude/projects/<cwd-slug>/<session-id>.jsonl. This script pairs each tool
call with its result, keeps user prompts, mid-turn messages and Claude's
visible text, drops thinking blocks, applies the scope rules you give it, and
redacts the output with generic defaults plus your own patterns.

Choosing the range: by default the whole transcript. If it contains the
markers "session-replay:start" and "session-replay:stop" (typed, or left by the
/replay-start and /replay-stop commands), only the span between the first start
and the next stop is used, and the marker exchange itself is left out. Or set
start_row/stop_row in the scope file (the listing shows each event's row).

It never writes words for anyone: prompts can only be replaced with an
abridged version you supply (and are tagged "abridged"), Claude's text can
only be dropped or replaced with text you supply, and nothing is invented.

Usage:
    extract_session.py SESSION.jsonl --out events.json [--scope scope.json]
                       [--redact local-redact.json] [--listing listing.txt]

scope.json (all keys optional):
    {
      "start_row": 0, "stop_row": null,        # transcript line range [start, stop)
      "use_markers": true,                     # honour session-replay:start/stop markers
      "rename_mcp": {"old-server": "new"},     # mcp__old-server__x -> mcp__new__x
      "drop_tools": ["SendFeedback"],          # tool names to omit entirely
      "drop_tool_input_regex": ["kubectl"],    # omit a call if its input JSON matches
      "drop_text_prefixes": ["Let me check the pod logs"],
      "drop_interject_prefixes": [],
      "replace_text_prefixes": {"Original start": "replacement text"},
      "abridge_prompts": {"Prompt start": "shortened prompt"},
      "insert_texts": [{"after_interject_prefix": "...", "delay_s": 20, "text": "verbatim"}],
      "truncate_result_after": {"tool_suffix": "marker string"},
      "omit_results": [{"tool_regex": "__kb_search$", "note": "Internal results omitted."}]
    }

local-redact.json (keep it out of git): {"patterns": [["regex", "replacement"], ...]}
"""

import argparse
import json
import re
import sys
from datetime import datetime
from pathlib import Path

MAXLEN = 6000

# Generic defaults. Placeholders are plain words on purpose: the player renders
# Claude's text as sanitized Markdown, which deletes anything shaped like an
# HTML tag, so "<user>" would silently vanish from the page.
DEFAULT_REDACT = [
    (r"/Users/[^/\s\"'\\]+", "/home/jovyan"),
    (r"/home/(?!jovyan\b)[^/\s\"'\\]+", "/home/jovyan"),
    (r"/private/tmp/[^\s\"'\\]*", "/tmp/scratch"),
    (r"(?:/var/folders|/tmp/claude-\d+)/[^\s\"'\\]*", "/tmp/scratch"),
    (r"eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+", "REDACTED-JWT"),
    (r"(?i)(bearer\s+)[A-Za-z0-9._~+/=-]{12,}", r"\1REDACTED-TOKEN"),
    (
        r"\b(?:ghp|gho|ghs|github_pat|glpat|sk|xox[abp])[-_][A-Za-z0-9_-]{16,}",
        "REDACTED-TOKEN",
    ),
    (r"\bAKIA[0-9A-Z]{16}\b", "REDACTED-KEY"),
    (r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", "jovyan@example.org"),
    (
        r"https?://jupyterhub\.[\w.-]+/user/[^/\s\"'\\]+/",
        "https://example.org/user/jovyan/",
    ),
    # Account identifiers (OIDC subject, principal IDs), also inside string-escaped
    # JSON that a tool returned as text.
    (
        (
            r'(\\?"(?:subject|sub|principal_sub|user_id|principal_id)\\?"\s*:\s*\\?")'
            r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
        ),
        r"\g<1>00000000-0000-0000-0000-000000000000",
    ),
    (r"<\d{1,3}(?:\.\d{1,3}){3}:\d+\?[^>]*>", "ADDRESS"),
    (r"\[[0-9a-f]{1,4}(?::[0-9a-f]{0,4}){3,7}\]", "IPV6-ADDRESS"),
    (r"\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b", "x.x.x.x"),
]


START_MARK = "session-replay:start"
STOP_MARK = "session-replay:stop"


def marker_range(rows):
    """Rows of the first start marker and the next stop marker (either may be None)."""
    start = stop = None
    for i, r in enumerate(rows):
        if r.get("type") not in ("user", "assistant", "queue-operation"):
            continue
        blob = json.dumps(r.get("message", r.get("content", "")), ensure_ascii=False)
        if start is None and START_MARK in blob:
            start = i
        elif start is not None and STOP_MARK in blob:
            stop = i
            break
    return start, stop


def is_marker_event(e):
    return START_MARK in e.get("text", "") or STOP_MARK in e.get("text", "")


def ts(s):
    # Python < 3.11 cannot parse a trailing "Z"; these scripts may run outside pixi.
    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()  # noqa: FURB162


def compile_rules(local_path):
    rules = list(DEFAULT_REDACT)
    if local_path:
        extra = json.loads(Path(local_path).read_text(encoding="utf-8"))
        # Local patterns run first: they are the most specific (usernames,
        # internal hostnames) and must win over the generic defaults.
        rules = [tuple(p) for p in extra.get("patterns", [])] + rules
    return [(re.compile(a), b) for a, b in rules]


def make_redactor(rules):
    def redact(value):
        s = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
        for pat, rep in rules:
            s = pat.sub(rep, s)
        if len(s) > MAXLEN:
            s = s[:MAXLEN] + f"\n… [truncated {len(s) - MAXLEN} characters]"
        return s

    return redact


def result_text(content):
    if isinstance(content, list):
        return "\n".join(x.get("text", "[" + x.get("type", "") + "]") for x in content)
    return content or ""


def startswith_any(text, prefixes):
    return any(text.startswith(p) for p in prefixes)


def extract(rows, scope, redact):
    rename = scope.get("rename_mcp", {})
    drop_tools = set(scope.get("drop_tools", []))
    drop_input = [re.compile(r) for r in scope.get("drop_tool_input_regex", [])]
    start = scope.get("start_row", 0)
    stop = scope.get("stop_row") or len(rows)
    explicit = "start_row" in scope or "stop_row" in scope
    if scope.get("use_markers", True) and not explicit:
        m_start, m_stop = marker_range(rows)
        if m_start is not None:
            # The marker exchange itself is not part of the story; any of it
            # inside the range is dropped by is_marker_event below.
            start = m_start + 1
            stop = m_stop if m_stop is not None else len(rows)
            print(f"markers: rows {start}..{stop}", file=sys.stderr)

    events, pending, prompts = [], {}, set()
    for idx in range(start, stop):
        r = rows[idx]
        if r.get("isSidechain"):
            continue  # a subagent's own transcript; its call and result appear in the parent
        kind = r.get("type")
        if kind == "queue-operation" and r.get("operation") == "enqueue":
            events.append(
                {
                    "kind": "interject",
                    "row": idx,
                    "t": ts(r["timestamp"]),
                    "text": r.get("content", ""),
                }
            )
        elif kind == "user":
            content = r["message"].get("content")
            if isinstance(content, str):
                if not content.startswith("<"):
                    events.append(
                        {
                            "kind": "prompt",
                            "row": idx,
                            "t": ts(r["timestamp"]),
                            "text": content,
                        }
                    )
                    prompts.add(content)
                continue
            for b in content or []:
                if b.get("type") == "tool_result" and b.get("tool_use_id") in pending:
                    call = pending.pop(b["tool_use_id"])
                    if call is None:
                        continue
                    call["result"] = result_text(b.get("content"))
                    call["is_error"] = bool(b.get("is_error"))
                    call["t_end"] = ts(r["timestamp"])
                elif b.get("type") == "text" and not b["text"].startswith("<"):
                    events.append(
                        {
                            "kind": "prompt",
                            "row": idx,
                            "t": ts(r["timestamp"]),
                            "text": b["text"],
                        }
                    )
                    prompts.add(b["text"])
        elif kind == "assistant":
            t = ts(r["timestamp"])
            for b in r["message"]["content"]:
                if b["type"] == "text" and b["text"].strip():
                    events.append(
                        {"kind": "text", "row": idx, "t": t, "text": b["text"]}
                    )
                elif b["type"] == "tool_use":
                    name = b["name"]
                    for old, new in rename.items():
                        name = name.replace(f"mcp__{old}__", f"mcp__{new}__")
                    blob = json.dumps(b["input"], ensure_ascii=False)
                    if b["name"] in drop_tools or any(
                        p.search(blob) for p in drop_input
                    ):
                        pending[b["id"]] = None
                        continue
                    call = {
                        "kind": "tool",
                        "row": idx,
                        "t": t,
                        "name": name,
                        "input": b["input"],
                    }
                    pending[b["id"]] = call
                    events.append(call)

    # `claude -p` records the prompt a second time as a queued message.
    events = [
        e for e in events if not (e["kind"] == "interject" and e["text"] in prompts)
    ]
    return [e for e in events if not is_marker_event(e)]


def apply_scope(events, scope):
    drop_text = scope.get("drop_text_prefixes", [])
    drop_inter = scope.get("drop_interject_prefixes", [])
    replace = scope.get("replace_text_prefixes", {})
    abridge = scope.get("abridge_prompts", {})
    inserts = scope.get("insert_texts", [])
    trunc = scope.get("truncate_result_after", {})
    # Keep the call (what was asked) but not what came back, for sources whose
    # content must not be published, such as internal notes or ticket threads.
    omit = [
        (re.compile(o["tool_regex"]), o.get("note", "Results omitted."))
        for o in scope.get("omit_results", [])
    ]
    out = []
    for e in events:
        if e["kind"] == "text":
            if startswith_any(e["text"], drop_text):
                continue
            for k, v in replace.items():
                if e["text"].startswith(k):
                    e["text"] = v
        if e["kind"] == "interject" and startswith_any(e["text"], drop_inter):
            continue
        if e["kind"] == "prompt":
            for k, v in abridge.items():
                if e["text"].startswith(k):
                    e["text"], e["abridged"] = v, True
        if e["kind"] == "tool":
            for pat, note in omit:
                if pat.search(e["name"]) and "result" in e:
                    e["result"] = note
            for suffix, marker in trunc.items():
                r = e.get("result", "")
                if e["name"].endswith(suffix) and marker in r:
                    e["result"] = r[: r.index(marker) + len(marker)] + " …"
        out.append(e)
        for ins in inserts:
            if e["kind"] == "interject" and e["text"].startswith(
                ins["after_interject_prefix"]
            ):
                out.append(
                    {
                        "kind": "text",
                        "t": e["t"] + ins.get("delay_s", 10),
                        "text": ins["text"],
                    }
                )
    out.sort(key=lambda e: e["t"])
    return out


def redact_events(events, redact):
    for e in events:
        for key in ("text", "result"):
            if key in e:
                e[key] = redact(e[key])
        if "input" in e:
            raw = json.dumps(e["input"], ensure_ascii=False)
            e["input"] = json.loads(redact(raw)) if len(raw) <= MAXLEN else redact(raw)
    return events


def listing(events):
    lines = []
    for i, e in enumerate(events):
        if e["kind"] == "tool":
            inp = e["input"] if isinstance(e["input"], dict) else {}
            sig = (
                inp.get("description")
                or inp.get("command")
                or inp.get("query")
                or inp.get("file_path")
                or ""
            )
            sig = str(sig).replace("\n", " ")[:90]
            row = e.get("row", "-")
            lines.append(f"{i:4d} row {row:>5} tool   {e['name'][-40:]:40s} {sig}")
        else:
            row = e.get("row", "-")
            lines.append(f"{i:4d} row {row:>5} {e['kind']:6s} {e['text'][:120]!r}")
    return "\n".join(lines) + "\n"


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("session", help="session transcript (.jsonl)")
    ap.add_argument("--out", required=True, help="events.json to write")
    ap.add_argument("--scope", help="scope rules (JSON)")
    ap.add_argument(
        "--redact", help="local redaction patterns (JSON); keep it out of git"
    )
    ap.add_argument("--listing", help="also write a numbered event listing for review")
    args = ap.parse_args()

    rows = [
        json.loads(line)
        for line in Path(args.session).read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    scope = (
        json.loads(Path(args.scope).read_text(encoding="utf-8")) if args.scope else {}
    )
    redact = make_redactor(compile_rules(args.redact))
    events = redact_events(apply_scope(extract(rows, scope, redact), scope), redact)
    if not events:
        sys.exit("no events in the selected range")
    Path(args.out).write_text(
        json.dumps(events, ensure_ascii=False, indent=1) + "\n", encoding="utf-8"
    )
    counts = {
        k: sum(e["kind"] == k for e in events)
        for k in ("prompt", "interject", "text", "tool")
    }
    print(f"wrote {args.out}: {len(events)} events {counts}")
    if args.listing:
        Path(args.listing).write_text(listing(events), encoding="utf-8")
        print(f"wrote {args.listing}")


if __name__ == "__main__":
    main()
