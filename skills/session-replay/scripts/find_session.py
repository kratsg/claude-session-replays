#!/usr/bin/env python3
"""List Claude Code transcripts for a working directory, newest first.

For each transcript: path, first and last timestamp, number of user prompts, the
first prompt, and whether it holds session-replay start/stop markers. Use it to
pick the session to replay, including the current one.

Usage: find_session.py [--cwd DIR] [--limit 10] [--markers]
"""

import argparse
import json
from pathlib import Path


def slug(path):
    return str(Path(path).resolve()).replace("/", "-")


def summarize(p):
    first = last = None
    prompts = 0
    first_prompt = ""
    markers = set()
    for line in p.read_text(encoding="utf-8", errors="replace").splitlines():
        if not line.strip():
            continue
        r = json.loads(line)
        t = r.get("timestamp")
        if t:
            first = first or t
            last = t
        if "session-replay:start" in line:
            markers.add("start")
        if "session-replay:stop" in line:
            markers.add("stop")
        if r.get("type") == "user" and isinstance(r["message"].get("content"), str):
            c = r["message"]["content"]
            if not c.startswith("<"):
                prompts += 1
                first_prompt = first_prompt or c
    return first, last, prompts, first_prompt, markers


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--cwd", default=".", help="the session's working directory")
    ap.add_argument("--limit", type=int, default=10)
    ap.add_argument(
        "--markers", action="store_true", help="only transcripts with markers"
    )
    args = ap.parse_args()
    folder = Path.home() / ".claude" / "projects" / slug(args.cwd)
    files = sorted(
        folder.glob("*.jsonl"), key=lambda f: f.stat().st_mtime, reverse=True
    )
    if not files:
        raise SystemExit(f"no transcripts in {folder}")
    shown = 0
    for f in files:
        first, last, prompts, fp, markers = summarize(f)
        if args.markers and not markers:
            continue
        mk = "+".join(sorted(markers)) or "-"
        print(f"{f}\n    {first} .. {last}  prompts={prompts}  markers={mk}")
        print(f"    first prompt: {fp[:100]!r}")
        shown += 1
        if shown >= args.limit:
            break


if __name__ == "__main__":
    main()
