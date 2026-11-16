#!/usr/bin/env python3
"""Create stories/YYYY-MM-DD-<slug>/ with events.json and a story.json skeleton.

The date and the `session` block (model, effort, client, mode) come from the
transcript, so they are never typed by hand: the folder date is the first
event's date in the story's timezone, which is what the build checks.

Usage:
    new_story.py --repo PATH --slug my-story --events events.json \
                 --session SESSION.jsonl [--timezone America/Chicago] [--title "..."]
"""

import argparse
import collections
import datetime
import json
import re
import shutil
import sys
from pathlib import Path
from zoneinfo import ZoneInfo


def session_info(jsonl):
    counts = collections.Counter()
    for line in Path(jsonl).read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        r = json.loads(line)
        if r.get("type") == "assistant" and not r.get("isSidechain"):
            counts[
                (
                    r["message"].get("model"),
                    r.get("effort"),
                    r.get("version"),
                    r.get("entrypoint"),
                )
            ] += 1
    if not counts:
        return {}
    model, effort, version, entry = counts.most_common(1)[0][0]
    info = {"model": model}
    if effort:
        info["effort"] = effort
    if version:
        info["client"] = f"Claude Code {version}"
    if entry:
        info["mode"] = {"cli": "interactive", "sdk-cli": "headless (claude -p)"}.get(
            entry, entry
        )
    return info


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--repo", required=True, help="claude-session-replays checkout")
    ap.add_argument(
        "--slug", required=True, help="lowercase-hyphenated name, e.g. pixi-hang-hunt"
    )
    ap.add_argument(
        "--events", required=True, help="events.json from extract_session.py"
    )
    ap.add_argument(
        "--session",
        required=True,
        help="the session transcript, for model/effort/client",
    )
    ap.add_argument("--timezone", default="UTC", help="IANA zone for dates and clocks")
    ap.add_argument("--title", default="TODO title")
    args = ap.parse_args()

    if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", args.slug):
        sys.exit("slug must be lowercase letters, digits and single hyphens")
    events = json.loads(Path(args.events).read_text(encoding="utf-8"))
    tz = ZoneInfo(args.timezone)
    date = datetime.datetime.fromtimestamp(events[0]["t"], tz).date().isoformat()
    folder = Path(args.repo) / "stories" / f"{date}-{args.slug}"
    if folder.exists():
        sys.exit(f"{folder} already exists")
    folder.mkdir(parents=True)
    shutil.copy(args.events, folder / "events.json")

    first_prompt = next((i for i, e in enumerate(events) if e["kind"] == "prompt"), 0)
    story = {
        "$schema": "../../schemas/story.schema.json",
        "schema": 1,
        "title": args.title,
        "subtitle": "TODO one or two sentences: what the session achieved",
        "session": session_info(args.session),
        "timezone": args.timezone,
        "setup": {
            "intro": "TODO what the reader needs to know about the tools",
            "steps": [],
        },
        "stats_extra": [],
        "chapters": [{"at": first_prompt, "title": "TODO"}],
        "cards": [],
        "outro": {
            "note": "TODO how this was recorded and what was redacted or left out",
            "links": [],
        },
    }
    (folder / "story.json").write_text(
        json.dumps(story, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(folder)


if __name__ == "__main__":
    main()
