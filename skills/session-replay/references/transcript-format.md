# Claude Code transcripts

## Where they are

Claude Code writes one JSONL file per session:

```
~/.claude/projects/<cwd-slug>/<session-id>.jsonl
```

`<cwd-slug>` is the working directory with `/` replaced by `-` (e.g.
`/Users/me/work` → `-Users-me-work`). The newest file in that folder is usually the
session you want; confirm by checking its first user prompt. Subagent transcripts live
under `<session-id>/subagents/`; you rarely need them, because each subagent's call and
final answer already appear in the parent transcript.

## Recording a session headless

To record a fresh run of a prompt, run it with `claude -p` from a dedicated working
directory, so its transcript lands in its own `~/.claude/projects/<slug>/` folder:

```bash
claude -p --model sonnet \
  --mcp-config ./mcp.json --strict-mcp-config \
  --allowedTools "mcp__myserver" "WebFetch(domain:docs.example.org)" \
  -- "$(cat prompt.md)"
```

- Capture from the transcript file, not from stdout. `--output-format stream-json` can
  stop updating partway through a long run while the transcript keeps growing.
- Write down the exact command (model, MCP config, allowlist): the story's setup steps
  must reproduce it.
- A live run uses real resources (servers, batch jobs, API quota). Ask the user before
  launching one, and clean up afterwards the way they decide (stop and delete servers,
  remove jobs).

## Record types that matter

| `type`                                      | What                                     | Use                                                                          |
| ------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------- |
| `user` with string `content`                | A prompt typed by the user               | `prompt` event (skip strings that start with `<`: those are harness notices) |
| `user` with `tool_result` blocks            | A tool's result                          | paired to its call by `tool_use_id`                                          |
| `assistant` with `text` blocks              | Claude's visible text                    | `text` event                                                                 |
| `assistant` with `tool_use` blocks          | A tool call                              | `tool` event; `input` is the arguments                                       |
| `assistant` with `thinking` blocks          | Private reasoning                        | always dropped                                                               |
| `queue-operation` with `operation: enqueue` | A message typed while Claude was working | `interject` event                                                            |

Each record has an ISO `timestamp`; a tool event's duration is its result's timestamp
minus its call's.

## Quirks

- `claude -p` records the prompt a second time as a queued message. Drop an
  `interject` whose text equals a prompt.
- Records with `isSidechain: true` belong to a subagent's own transcript; skip them.
- Occasionally an assistant text block shown on screen is missing from the transcript.
  Restore it only from a verbatim copy (e.g. the user's terminal scrollback) and say so;
  never reconstruct it from memory.
- MCP tool names look like `mcp__<server>__<tool>`. If the server name differs from what
  readers would configure, rename it consistently (`rename_mcp` in the scope file).
- Assistant records carry `message.model`, `effort`, `version` and `entrypoint`
  (`cli` = interactive, `sdk-cli` = headless). `new_story.py` reads these for the
  story's `session` block.
