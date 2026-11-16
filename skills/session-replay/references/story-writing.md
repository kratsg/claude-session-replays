# Writing story.json

The reader is a newcomer who wants to understand how the tools work: how they were set
up, what Claude did step by step, and why. The page is an explainer, not a log viewer.
Everything you write in `story.json` serves that.

## Words belong to their authors

- The user's messages may only be abridged (set `abridged` via the scope file); never
  reworded.
- Claude's text may only be dropped or replaced with a shorter verbatim excerpt; never
  rewritten. Masking a name or address is redaction, not rewording, and is fine.
- Commentary is yours, and it lives in `story.json` cards, clearly separate from the
  transcript.

## Freeze events.json first

Card and chapter anchors (`at`) are indices into `events.json`. Finish scoping and
redaction before writing any card; if `events.json` changes later, re-check every anchor
with `check_story.py`.

## Hero and setup

- `title`: short, says what happened ("Z → ee in one prompt on the ATLAS AF").
- `subtitle`: one or two sentences with the outcome and a concrete number if there is one.
- `session`: filled by `new_story.py` from the transcript; do not edit by hand.
- `setup.steps`: how a reader reproduces the setup, with the exact commands the session
  used (model, MCP server, allowlist). If the session ran headless, show that command,
  not an idealised one.
- `stats_extra`: one or two headline results, verbatim from the session.

## Chapters

Start a chapter at each user prompt and at each clear change of phase (searching →
running → verifying). Three to six chapters is typical. Titles are short and active:
"Find a copy at the facility", "Verify everything".

## Cards

A card explains one thing the reader would not otherwise understand: what a tool does,
why Claude chose it, what a result means, what went wrong and how it recovered. Aim for
one card per meaningful step, not per tool call. Keep each to two or three sentences.

**Check every claim against its anchored event.** Run
`check_story.py stories/<folder>` and read each card next to the event it is anchored
to. Numbers, durations, counts and descriptions must match the input or result shown.
Common mistakes this catches:

- counts that include things they should not (directories counted as files);
- statements about a tool's limits that the session itself contradicts (a tool said to
  return only text actually returned an image);
- setup details that differ from what was really run (an allowlist described as
  narrower than it was).

If a claim cannot be checked from the session, cut it.

**Explain behaviour from the session, not from the user's configuration.** The transcript
can show you the user's private setup: their `CLAUDE.md`, personal rules, memory and
hooks. Do not quote or paraphrase it in cards ("it does this because the user's own rules
say…"); that publishes private configuration. Describe what Claude did and why it helps
the reader ("it stages the two files by name, so the untracked log stays out"). If a step
only makes sense with that context, say a setting was in effect without its content, and
only if the user agrees.

## Time

- Set `timezone` to where the session happened; the folder date and every clock use it.
- Time spent waiting for the user's next prompt is skipped automatically.
- Long compute waits can collapse and fast-forward. Polling is opt-in: list the tools the
  session polled with in `poll_tools` (names after the `mcp__<server>__` prefix, e.g.
  `["build_status", "get_job"]`) and set `poll_label` / `ff_label` to describe the wait
  ("checked on the build", "build steps"). Without `poll_tools`, nothing is collapsed.
- The built-in stats are generic (session length, tool calls, MCP calls and servers).
  Anything specific to one MCP server, such as which of its services were used, goes in
  `stats_extra`.

## Images

A card or the outro can show an image the session produced: put the file in the story's
`assets/` folder and reference it as `{"src": "assets/plot.png", "alt": "..."}`. Check
with the user that the image may be public (for example, plots labelled "Internal" may
not be).

## Outro

Say how the session was recorded, what was redacted or left out, and link the sources a
reader would want (the prompt, the docs, resulting pull requests).
