# CLAUDE.md

Guidance for AI coding agents (Claude Code and others; `AGENTS.md` is a symlink to this
file) working in this repository.

## What this is

Real Claude Code sessions, replayed as scrollable pages with commentary. A shared,
generic player (`player/`) renders one folder per story (`stories/YYYY-MM-DD-<slug>/`),
and GitHub Pages serves the result. The `session-replay` skill (`skills/session-replay/`)
is the workflow for turning a session into a new story.

## Commands

Everything runs through [pixi](https://pixi.sh):

```bash
pixi run validate   # story.json / events.json against schemas/
pixi run build      # validate, then build _site/
pixi run serve      # build, then serve http://localhost:8000
pixi run lint       # every pre-commit hook (prek): prettier, biome, ruff, codespell, schemas, zizmor
pixi run release X.Y.Z   # bump PLAYER_VERSION, commit, tag player-vX.Y.Z (tbump)
```

## Layout

| Path                         | What                                                                                                            |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `player/`                    | `index.html`, `style.css`, `app.js`: generic, nothing story-specific                                            |
| `stories/YYYY-MM-DD-<slug>/` | `events.json` (redacted session), `story.json` (commentary), optional `assets/`                                 |
| `schemas/`                   | JSON Schemas for `story.json` and `events.json`                                                                 |
| `tools/build_site.py`        | Builds `_site/`, checks schema versions, anchors and folder dates                                               |
| `skills/session-replay/`     | The skill (also a plugin): `SKILL.md`, `scripts/`, `references/`, `commands/` (`/replay-start`, `/replay-stop`) |

## Rules

- **Privacy first.** Stories are public. Never add a story, or change one, without
  running `skills/session-replay/scripts/leak_scan.py` on it and reading every hit.
  Never commit anything that identifies people, hosts or internal documents; see
  `skills/session-replay/references/redaction.md`. Old commits stay reachable on GitHub
  after a force-push, so prevention is the only real fix.
- **Never hand-edit `events.json`.** Regenerate it with
  `skills/session-replay/scripts/extract_session.py` and a scope file, so every change is
  reproducible and redaction is applied consistently.
- **Words belong to their authors.** Transcript text may be dropped, abridged with the
  author's wording, or redacted; never reworded. Commentary goes in `story.json` cards.
- **Keep the player generic.** Anything specific to one story belongs in its
  `story.json`. A change to the `story.json` format bumps `STORY_SCHEMA` in
  `player/app.js` and the `schema` const in `schemas/story.schema.json`, and needs a
  player release.
- **The player is plain browser JavaScript** in ES5 style, loaded without a bundler;
  keep it that way (see `biome.jsonc` for which lint rules are off and why). Insert
  event content with `textContent`; only agent Markdown goes through marked + DOMPurify.
- **Before committing:** `pixi run lint` and `pixi run build` must pass.
- **Commits** follow Conventional Commits. Credit AI help with an
  `Assisted-by: <tool> (<vendor>)` trailer; see `CONTRIBUTING.md`.
