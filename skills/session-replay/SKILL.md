---
name: session-replay
description: Turn a Claude Code session into a published, scrollable replay page with commentary, in the claude-session-replays repo. Use this whenever the user wants to share, showcase, demo or explain a past or new Claude Code session (e.g. "make a replay of this session", "turn my last run into a demo page", "record this prompt and publish it like the other replays", "show people how Claude used our MCP server"), even if they don't say "replay". Covers capturing the transcript, scoping it, redacting private details, writing commentary, building and publishing.
---

# Session replay

A replay turns one Claude Code session into a page that a newcomer can scroll through:
the prompt types out, Claude's steps appear in order with commentary beside them, long
waits fast-forward, and every tool call opens to show exactly what went in and out.
Published replays live in [claude-session-replays](https://github.com/kratsg/claude-session-replays):
one folder per story under `stories/`, rendered by a shared player.

The work has two failure modes that matter far more than polish:

- **Leaking** something private onto a public page. Old commits stay reachable on GitHub
  even after a force-push, so redaction has to be right before the first push.
- **Misrepresenting** what happened: putting words in someone's mouth, or commentary that
  the session itself contradicts.

The steps below exist to prevent both. Do them in order, and stop at each review gate.

## Three ways in

The transcript Claude Code writes is always the recording; what differs is how you choose
the part to replay. Work out which one the user means:

- **A prompt to record.** The user has a prompt (often a demo) and wants a clean run of
  it. Run it headless (step 1), then replay the whole transcript.
- **Start and stop markers.** In an interactive session the user typed `/replay-start`
  (or the text `session-replay:start`) before the part to show, and `/replay-stop` (or
  `session-replay:stop`) after it. `extract_session.py` uses the span between the
  markers automatically and leaves the marker exchange out. Find the transcript with
  `find_session.py --markers`.
- **After the fact.** The session is over (or you are at its end) and the user wants a
  replay of some or all of it. Find the transcript with `find_session.py`, show the user
  the listing, and agree the range (`start_row`/`stop_row` in the scope file, using the
  row numbers the listing shows). Leave out the request to make the replay itself and
  anything after it. Replay what is in the transcript as faithfully as it allows; if
  something the user remembers is missing, say so rather than recreate it.

## 0. Set up

Work in a clone (or the user's fork) of `claude-session-replays`; everything below runs
from its root. It uses [pixi](https://pixi.sh): `pixi run validate`, `pixi run build`,
`pixi run serve`, `pixi run lint`. Scripts are in this skill's `scripts/` folder; keep
scratch files (listing, scope, local redaction patterns) outside the repo.

Ask the user, before anything else:

1. **Which session, and which way in?** A prompt to record, a session with markers, or a
   finished session (`scripts/find_session.py --cwd <dir>` lists a directory's sessions;
   [references/transcript-format.md](references/transcript-format.md) explains where they
   live).
2. **What is private?** Their usernames, colleagues, hosts, projects, internal documents.
   They know; you don't. Write their answers into `local-redact.json` and `scope.json`
   (see [references/redaction.md](references/redaction.md)).
3. **Which part of the session?** The whole thing, or certain turns. Side quests the
   reader doesn't need are dropped with scope rules, not by hand-editing events.
4. **Extra context?** Logs or docs that help explain the steps. Optional; see
   [references/extra-context.md](references/extra-context.md).

## 1. Capture (only for a new recording)

A live run uses real resources, so ask before launching it. Run the prompt headless from
a dedicated directory and record the exact command; take the transcript from
`~/.claude/projects/<slug>/`, not from stdout. Clean up what the run created (servers,
jobs) as the user decides. Details: [references/transcript-format.md](references/transcript-format.md).

## 2. Extract, scope and redact

```bash
python3 <skill>/scripts/extract_session.py SESSION.jsonl --out /tmp/replay/events.json \
  --scope /tmp/replay/scope.json --redact /tmp/replay/local-redact.json \
  --listing /tmp/replay/listing.txt
python3 <skill>/scripts/leak_scan.py /tmp/replay/events.json --local /tmp/replay/local-redact.json
```

Iterate on `scope.json` until the listing tells the story the user wants: drop side
quests, abridge prompts only with the user's wording, restore missing text only from a
verbatim copy. Then read every leak-scan hit, and skim the large tool results yourself.

**Review gate 1:** show the user the listing and the scan output, say what you dropped
and masked, and ask what else is private. Do not continue until they agree.

## 3. Create the story

```bash
python3 <skill>/scripts/new_story.py --repo . --slug <short-name> \
  --events /tmp/replay/events.json --session SESSION.jsonl --timezone <IANA zone>
```

This creates `stories/YYYY-MM-DD-<slug>/` with `events.json` and a `story.json`
skeleton. The date and the `session` block (model, effort, client, mode) come from the
transcript. From here on `events.json` is frozen; if it must change, re-extract and
re-check the anchors.

## 4. Write the commentary

Fill in `story.json`: title, subtitle, setup steps that reproduce the real setup,
chapters, and cards that explain the steps a newcomer wouldn't understand. Follow
[references/story-writing.md](references/story-writing.md).

Then check every claim:

```bash
python3 <skill>/scripts/check_story.py stories/<folder>
```

It prints each card next to the event it is anchored to. Fix or cut any card whose
numbers or description the event doesn't support.

## 5. Build and look at it

```bash
pixi run lint      # schemas, formatting, lint
pixi run serve     # http://localhost:8000
```

Open the story and scroll through it: the scrubber should follow the scroll, cards should
sit beside their events, and nothing should read as broken. If the session polled for
progress, list those tools in `poll_tools` in `story.json` so the waits fast-forward.

**Review gate 2:** tell the user the local URL and ask them to read it. Run `leak_scan.py`
once more on every file you will commit (`events.json` and `story.json`).

## 6. Publish (only when the user says so)

Commit the story folder on a branch with a Conventional Commits message, and open a pull
request, or push, as the user prefers. GitHub Pages deploys from `main`. Never force-push
or rewrite published history without the user's explicit approval.

## Checklist

- [ ] Session, private details, scope and extra context agreed with the user
- [ ] `events.json` extracted with local patterns and scope rules; leak scan read in full
- [ ] Review gate 1 passed
- [ ] Story folder created with `new_story.py`
- [ ] Every card checked against its event with `check_story.py`
- [ ] `pixi run lint` clean; the page reviewed locally (review gate 2)
- [ ] Final leak scan on the committed files; published only on the user's say-so
