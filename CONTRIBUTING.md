# Contributing

Thanks for helping! Contributions are welcome: new replays, player improvements, fixes
to the skill, and documentation.

## Setup

Install [pixi](https://pixi.sh), then:

```bash
pixi run lint    # all checks (also installs the git hooks' environments)
pixi run test    # unit tests for the skill's scripts
pixi run serve   # http://localhost:8000
```

To run the checks on every commit, install the hooks once with `pixi run prek install`.

## Adding a replay

Use the `session-replay` skill in Claude Code: it walks through capturing, scoping,
redacting and annotating a session (see `skills/session-replay/SKILL.md`, or the
"make your own" section of the site). By hand, the steps are the same: extract with
`skills/session-replay/scripts/extract_session.py`, create the folder with
`new_story.py`, write `story.json`, check it with `check_story.py`, and run
`leak_scan.py` before opening a pull request.

A replay pull request must:

- contain only `stories/YYYY-MM-DD-<slug>/` (plus `assets/` if any);
- pass `pixi run lint` and `pixi run build`;
- be clean under `leak_scan.py`, with any accepted hits explained in the PR;
- describe what was dropped, redacted or abridged, and confirm you are entitled to
  publish the session and its outputs under CC BY 4.0.

## Changing the player or tools

- Keep the player generic and in its existing plain-JavaScript style (see `CLAUDE.md`).
- A change to the `story.json` format bumps `STORY_SCHEMA` and the schema file, and every
  existing story must still validate and build.
- Releases: `pixi run release X.Y.Z` (semver; tags `player-vX.Y.Z`).

## Commits and pull requests

- Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:` …), with a body that explains
  why, not only what.
- One logical change per commit; open a pull request against `main`.

## AI-assisted contributions

AI coding assistants are welcome here (the project is about them, after all), with these
expectations:

- **You are responsible for every line you submit.** Read and understand AI-generated
  changes before opening a pull request; you should be able to explain any of them in
  review.
- **Disclose it.** Add a trailer to each commit with substantial AI help, e.g.
  `Assisted-by: Claude (Anthropic)`, and mention it in the pull request.
- **Verify, don't trust.** Run `pixi run lint` and `pixi run build`, and look at the
  rendered page yourself. For commentary, check every claim against the event it
  describes (`check_story.py`).
- **Privacy review is human work.** An assistant can redact, but a person must read the
  leak scan and the published content before it goes public. Do not let an agent push
  a replay unreviewed.
- **Agents working in this repo** should follow `CLAUDE.md` (also available as
  `AGENTS.md`).

## License

By contributing, you agree that code contributions are licensed under the MIT License
(`LICENSE`) and replay content under `stories/` under CC BY 4.0 (`stories/LICENSE`).
