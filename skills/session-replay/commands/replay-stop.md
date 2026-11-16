---
description: Mark the end of a session replay recording and build the replay from the start marker to here.
---

session-replay:stop

The replay recording is over. Reply in one short line that includes the marker text
`session-replay:stop`, then use the session-replay skill to turn the part of this session
between the `session-replay:start` and `session-replay:stop` markers into a replay.
This session's transcript is the newest `.jsonl` under `~/.claude/projects/<cwd-slug>/`
that contains both markers (`find_session.py --markers` lists it); `extract_session.py`
picks the range from the markers by itself. Follow the skill from step 0: ask what is
private before extracting.
