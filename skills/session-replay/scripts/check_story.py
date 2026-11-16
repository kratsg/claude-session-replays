#!/usr/bin/env python3
"""Print every chapter and commentary card beside the event it is anchored to.

Use it to verify each card's claims against what actually happened: the
anchored event's kind, tool, duration, input and the start of its result are
shown under the card. Exits non-zero if an anchor is out of range.

Usage: check_story.py stories/YYYY-MM-DD-slug [--chars 400]
"""

import argparse
import json
import sys
from pathlib import Path


def describe(e, chars):
    if e["kind"] != "tool":
        return f"[{e['kind']}] {e.get('text', '')[:chars]}"
    took = f"{e['t_end'] - e['t']:.1f}s" if "t_end" in e else "?"
    inp = (
        e["input"]
        if isinstance(e["input"], str)
        else json.dumps(e["input"], ensure_ascii=False)
    )
    err = " ERROR" if e.get("is_error") else ""
    return (
        f"[tool {e['name']} {took}{err}]\n      input:  {inp[:chars]}\n"
        f"      result: {(e.get('result') or '')[:chars]}"
    )


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("story_dir")
    ap.add_argument("--chars", type=int, default=400)
    args = ap.parse_args()
    d = Path(args.story_dir)
    events = json.loads((d / "events.json").read_text(encoding="utf-8"))
    story = json.loads((d / "story.json").read_text(encoding="utf-8"))
    bad = 0
    for label, items in (
        ("CHAPTER", story.get("chapters", [])),
        ("CARD", story.get("cards", [])),
    ):
        for it in items:
            at = it["at"]
            print(f"\n{label} @{at}: {it['title']}")
            if it.get("body"):
                print(f"   says:  {it['body']}")
            if not 0 <= at < len(events):
                print("   !! anchor out of range")
                bad += 1
                continue
            print(f"   event: {describe(events[at], args.chars)}")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
