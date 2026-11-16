# Claude session replays

Real Claude Code sessions, replayed as scrollable pages with commentary: the prompt types out,
the scrubber follows your scroll, long waits on compute fast-forward, and every tool call opens to
show exactly what went in and what came back.

Live site: <https://kratsg.github.io/claude-session-replays/>

## Layout

| Path                          | What                                                                                                                                                                                                                                            |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `player/`                     | The replay player: `index.html`, `style.css`, `app.js`. Generic; nothing story-specific.                                                                                                                                                        |
| `stories/YYYY-MM-DD-<slug>/`  | One story, named like a blog post so folders sort by date (the date must match the session's first event in the story's timezone): `events.json` (the redacted session), `story.json` (title, setup, chapters, commentary), optional `assets/`. |
| `tools/build_site.py`         | Builds `_site/`: one folder per story (player + story + `data.js`) and a landing page.                                                                                                                                                          |
| `schemas/`                    | JSON Schemas for `story.json` and `events.json`; each `story.json` points at its schema via `$schema`.                                                                                                                                          |
| `pixi.toml`                   | Dependencies and tasks (`validate`, `build`, `serve`, `lint`, `release`).                                                                                                                                                                       |
| `.pre-commit-config.yaml`     | Hooks run by [prek](https://github.com/j178/prek): prettier, biome (JS/CSS lint, `biome.jsonc`), ruff, codespell, schema validation, zizmor.                                                                                                    |
| `tbump.toml`                  | Player release configuration.                                                                                                                                                                                                                   |
| `.github/workflows/pages.yml` | Builds on every PR; builds and deploys GitHub Pages on `main`.                                                                                                                                                                                  |

## Stories

| Story                                                                 | Session                                                                                                                                                                    |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`2026-11-15-atlas-af-rntuple`](stories/2026-11-15-atlas-af-rntuple/) | An agent searches the ATLAS knowledge base and converts 32 GB of TTree ntuples to RNTuple with HTCondor batch jobs on the UChicago AF, through the `atlas-af` MCP server.  |
| [`2026-11-15-atlas-af-zee`](stories/2026-11-15-atlas-af-zee/)         | One prompt to Claude Code (Sonnet) builds a Z→ee tutorial notebook on the AF's JupyterHub: AMI, Rucio, the facility XCache and a fit to the Z peak, in under four minutes. |

## View locally

Dependencies are managed with [pixi](https://pixi.sh):

```bash
pixi run validate   # check every story.json / events.json against schemas/
pixi run build      # validate, then build _site/
pixi run serve      # build, then serve http://localhost:8000
pixi run lint       # every pre-commit hook on the whole repo
```

Each `_site/<story>/` folder is self-contained (the player, the story and a `data.js`), so it
also opens straight from disk, which is handy for viewing offline.

## Versions

`player/app.js` defines `PLAYER_VERSION` (semver) and `STORY_SCHEMA`, the newest `story.json`
schema it understands. Each story declares `"schema"`; the build and the player refuse a story
newer than the player. Release a new player with `pixi run release X.Y.Z`: tbump updates `PLAYER_VERSION`, commits and tags `player-vX.Y.Z`. To freeze a story against future
player changes, copy a tagged player into a self-contained folder next to it.

## story.json

| Key                                    | Meaning                                                                                                                                 |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `schema`                               | Story schema version (currently `1`).                                                                                                   |
| `title`, `subtitle`                    | Hero text.                                                                                                                              |
| `session`                              | `{model, effort, client, mode}` from the transcript, shown as chips in the hero.                                                        |
| `timezone`                             | IANA zone for the clock (e.g. `America/Chicago`); default is the viewer's zone.                                                         |
| `setup`                                | `{intro, steps: [{label, code?, note?}]}`: how to reproduce the setup.                                                                  |
| `stats_extra`                          | Extra `{label, value}` tiles next to the computed stats.                                                                                |
| `chapters`                             | `[{at, title}]`: `at` is an index into `events.json`.                                                                                   |
| `cards`                                | `[{at, title, body, image?}]`: commentary beside event `at`; `image` is `{src, alt, caption?}` with `src` relative to the story folder. |
| `outro`                                | `{note, links: [{label, href}], image?}`.                                                                                               |
| `poll_tools`, `poll_label`, `ff_label` | Which tools count as polling (collapsed and fast-forwarded) and how to label them.                                                      |
