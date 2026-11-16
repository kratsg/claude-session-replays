# Optional: extra context for the commentary

The transcript shows what Claude saw. Sometimes the commentary is better if you also
know what happened behind a tool call: a gateway's audit log, a server's own logs, a
job's accounting record, the documentation of an internal service.

If the user offers such sources, use them only to understand and explain, for example
to check that a 20-second call was the backend and not the network, or to describe what
a service does in one accurate sentence.

- Never copy anything from these sources into `events.json` or `story.json` verbatim:
  they usually contain hostnames, other users' activity and internal identifiers. If a
  fact from them belongs on the page, state it in your own words in a card, and only if
  it is safe to publish.
- Do not fetch them on your own initiative; they often need privileged access. Ask the
  user, and accept "no" as the default.
- Note in the outro that the commentary drew on additional logs, without naming systems.

Domain packs: if the user has standing context for a family of sessions (for example, a
paragraph explaining what each of their MCP servers does), they can keep it in a local
file and point you at it each time. Treat it like any other extra context.
