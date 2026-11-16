#!/usr/bin/env python3
"""Scan files for things that should not be published; exit 1 if any are found.

Checks the generic patterns below plus any in a local patterns file (the same
local-redact.json used with extract_session.py: each pattern's regex is
scanned for). Review every hit: either fix the redaction and re-extract, or
confirm the hit is meant to be public.

Usage: leak_scan.py FILE [FILE ...] [--local local-redact.json] [--allow REGEX ...]
"""

import argparse
import json
import re
import sys
from pathlib import Path

CHECKS = {
    "ipv4 address": r"\b(?!x\.x)\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b",
    "email address": r"[A-Za-z0-9._%+-]+@(?!example\.org)[A-Za-z0-9.-]+\.[A-Za-z]{2,}",
    "macOS home path": r"/Users/[^/\s\"]+",
    "home path": r"/home/(?!jovyan\b)[^/\s\"]+",
    "temp path": r"/private/tmp/|/var/folders/",
    "jwt": r"eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+",
    "bearer token": r"(?i)bearer\s+(?!REDACTED)[A-Za-z0-9._~+/=-]{12,}",
    "api token": r"\b(?:ghp|gho|ghs|github_pat|glpat|sk|xox[abp])[-_][A-Za-z0-9_-]{16,}",
    "aws key": r"\bAKIA[0-9A-Z]{16}\b",
    "hub user url": r"/user/(?!jovyan/)[^/\s\"]+/(?:lab|tree|api)",
    "html-like placeholder": r"(?<![\w`])<(?:user|name|host|ip|token|email|path)>",
}


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("files", nargs="+")
    ap.add_argument(
        "--local", help="local-redact.json whose patterns are also scanned for"
    )
    ap.add_argument(
        "--allow", action="append", default=[], help="regex of hits to accept"
    )
    args = ap.parse_args()

    checks = dict(CHECKS)
    if args.local:
        for i, (pat, _) in enumerate(
            json.loads(Path(args.local).read_text(encoding="utf-8"))["patterns"]
        ):
            checks[f"local pattern {i}"] = pat
    allow = [re.compile(a) for a in args.allow]
    hits = 0
    for f in args.files:
        text = Path(f).read_text(encoding="utf-8", errors="replace")
        for name, pat in checks.items():
            found = sorted({m.group(0) for m in re.finditer(pat, text)} - {""})
            found = [h for h in found if not any(a.search(h) for a in allow)]
            if found:
                hits += len(found)
                print(f"{f}: {name}: {found[:6]}{' …' if len(found) > 6 else ''}")
    print(f"{hits} hit(s) in {len(args.files)} file(s)")
    sys.exit(1 if hits else 0)


if __name__ == "__main__":
    main()
