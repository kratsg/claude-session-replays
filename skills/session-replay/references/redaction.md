# Redaction

A replay is published on the open web, often permanently: a force-push does not delete
an old commit from GitHub, and the old commit stays reachable by its SHA until GitHub
garbage-collects it or Support purges it. Get redaction right before the first push.

## Three layers

1. **Generic defaults** in `scripts/extract_session.py`: home and temp paths (a trailing
   file name is kept), emails (to the neutral `someone@example.org`),
   IPv4/IPv6 addresses, JWTs, bearer and API tokens, cloud keys, JupyterHub user URLs,
   and account-ID fields (`subject`, `sub`, `principal_id`, …), including inside
   string-escaped JSON that a tool returned as text.
2. **Local patterns** in a `local-redact.json` you keep out of git (it names the very
   things you are hiding):

   ```json
   {
     "patterns": [
       ["\\bmyuser\\b", "jovyan"],
       ["internal-host\\.example\\.edu", "host.example.org"],
       ["\\bcolleagueuser\\b", "colleague"]
     ]
   }
   ```

   Local patterns run before the defaults. Pass the same file to `leak_scan.py --local`.
   Map the user's own email to `jovyan@example.org` here; the default sends every other
   address to `someone@example.org`, so a colleague's action is never shown as the user's.
   If the story needs to tell people apart, give each a distinct plain name.

3. **Scope rules** in `scope.json` for whole pieces that must not appear: drop tool calls
   (`drop_tools`, `drop_tool_input_regex`), drop or replace Claude's text by prefix, and
   `omit_results` for sources whose content is not public, e.g. an internal knowledge
   base: the call and its query stay, the result becomes a note.

## Use plain-word placeholders

The player renders Claude's text as sanitized Markdown, which deletes anything shaped
like an HTML tag. A placeholder like `<user>` silently disappears (`/user//lab`). Use
plain words: `jovyan`, `example.org`, `colleague`, `x.x.x.x`, `REDACTED-TOKEN`.

## What to look for beyond the defaults

These were all missed by an early version and found only after publishing:

- **Usernames** in paths (`/data/<name>`), in `whoami`/`ls` output, and in job owner fields.
- **Other people's account names**, e.g. in file paths or data-set scopes of files the
  session read. A replay never needs them; give each person a distinct neutral name.
- **Colleagues' names** quoted in Claude's own text after it read a ticket or a note.
- **Service URLs that embed a user** (notebook servers, dashboards).
- **Account identifiers** returned by "who am I" or usage tools.
- **Internal documents**: search results from an organisation's internal notes, tickets
  or meeting minutes; figures labelled "Internal". Ask the user how their organisation
  treats these; the safe default is to omit them.
- **What Claude derived from an omitted source.** Omitting a result does not remove what
  Claude wrote after reading it: document IDs, titles and links (an internal note's number
  and its access-restricted URL) in Claude's text or in files it wrote. Search for them and
  ask the user, or mask them with local patterns.

## Review gates

1. After extraction: run `leak_scan.py` on `events.json` and read every hit. Then skim
   the listing and the larger tool results yourself; the scanner only knows patterns.
2. Show the user the event listing and the scan output, and ask them what else is
   private (they know their colleagues, hosts and projects; you do not).
3. Before pushing: scan again on every file that will be committed, including
   `story.json`.

Never publish while a hit is unexplained. When the user accepts a hit as public, pass it
with `--allow` so later scans stay quiet about it.
