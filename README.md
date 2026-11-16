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
pixi run test       # unit tests for the skill's scripts
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
| `stats_extra`                          | Extra `{label, value, sub?}` tiles next to the generic stats (session length, tool calls, MCP calls). Server-specific stats go here.    |
| `chapters`                             | `[{at, title}]`: `at` is an index into `events.json`.                                                                                   |
| `cards`                                | `[{at, title, body, image?}]`: commentary beside event `at`; `image` is `{src, alt, caption?}` with `src` relative to the story folder. |
| `outro`                                | `{note, links: [{label, href}], image?}`.                                                                                               |
| `poll_tools`, `poll_label`, `ff_label` | Opt-in: tool names whose consecutive calls collapse and fast-forward as waiting, and how to label them.                                 |

## Make your own replays

Install the `session-replay` skill in Claude Code:

```text
/plugin marketplace add kratsg/claude-session-replays
/plugin install session-replay@claude-session-replays
```

or, with the [GitHub CLI](https://cli.github.com/) (`gh skill`, in preview; works for any agent
it supports):

```bash
gh skills install kratsg/claude-session-replays session-replay --agent claude-code --scope user
```

The plugin also adds `/replay-start` and `/replay-stop`; with `gh skills`, type the marker text
`session-replay:start` / `session-replay:stop` instead.

Then fork this repository, open Claude Code in your fork, and ask for a replay of a
session (for example, "make a replay of my last session in ~/work/my-project"). The skill
(`skills/session-replay/`) captures and redacts the transcript, drafts the commentary with
you, and stops for your review before anything is published. Three ways to pick what to
replay: record a prompt headless, mark a span of an interactive session with
`/replay-start` and `/replay-stop`, or point it at a finished session. Contributing a replay back
here: see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Copyright © 2026 [Giordon Stark](https://giordonstark.com/).

- Code (player, tools, skill): [MIT](LICENSE).
- Replays (`stories/`): [CC BY 4.0](stories/LICENSE).

If you build on this work, keep the credit to Giordon Stark and link back to this
project. Every page built with the player shows that credit in its footer.
