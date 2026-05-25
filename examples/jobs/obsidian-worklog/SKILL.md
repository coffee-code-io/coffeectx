---
name: obsidian-worklog
description: Every morning, summarise yesterday's actions into an Obsidian daily note.
# User jobs default to read-only graph access. This skill needs to write
# a markdown file to the Obsidian vault, so it opts into `write_file`
# explicitly via the Anthropic Agent Skills `allowed-tools` field.
allowed-tools:
  - search
  - get_by_symbol_text
  - regex
  - raw_query
  - get_node_by_id
  - resolve_symbols
  - write_file
coffeecode:
  job:
    triggers:
      - kind: cron
        expression: "0 9 * * *"   # 09:00 local time, every day
    defaultEnabled: false          # opt-in via the Scheduler tab
  requiredEnv:
    - OBSIDIAN_VAULT               # absolute path to the vault root
---

# Obsidian worklog — daily summary

You're running as a fresh single-shot agent. The `## Environment` block
above gives you `TODAY` (anchor for "yesterday") and `OBSIDIAN_VAULT`
(absolute vault root). Substitute their literal values everywhere below.

You have full graph query access (`search`, `raw_query`, `regex`,
`get_by_symbol_text`, `get_node_by_id`, `resolve_symbols`) and a
`write_file` tool for the output. Yesterday's events live in the graph
already — you decide what to query.

Goal: write **one** Obsidian daily note at
`<OBSIDIAN_VAULT>/Daily/<YESTERDAY>.md` summarising yesterday.

## Steps

1. **Compute yesterday.** Subtract one day from `TODAY` (local time). Format
   `YYYY-MM-DD`. Use this for the filename and the H1.

2. **Collect what happened yesterday.** The relevant node types are:

   - `Plan` — plans authored in plan-mode (the highest-signal of all).
   - `LocalChangeEvent` — concrete shifts in implementation / contract /
     assumption.
   - `LocalDecision` / `Choice` — deliberate design picks.
   - `AgentSummary` — the assistant's own end-of-turn report-back.

   Filter by the node's first-class `created_at` timestamp. Build the
   ISO bounds from your computed `<YESTERDAY>` and `<TODAY>`:

   ```
   IsType "LocalChangeEvent",
     CreatedAfter  "<YESTERDAY>T00:00:00Z",
     CreatedBefore "<TODAY>T00:00:00Z"
   ```

   The results' `$created_at` field is returned as an ISO string in the
   raw_query response — use it for ordering inside each session.

   Group results by `sessionId` (a Symbol field on each event) so each
   session becomes one section in the note.

3. **For each session**, derive a one-line title (from `AgentSummary.text`
   or the first `UserInput.text` if no summary). Pull touched files from
   any `FileOperation` events whose `sessionId` matches.

4. **Compose the note.** Keep it tight — this is a personal worklog, not
   release notes. Markdown, bullets only:

   ```markdown
   # 2026-05-23

   ## Per-node state machine + force-kill SIGINT
   - Decisions: rename `skill:` prefix → plain job names; defer history flag
   - Files touched: indexer/src/jobs/scheduler.ts, packages/core/src/db.ts
   - Outcome: state machine landed; SIGINT watchdog also fixed

   ## Skill registry refactor
   - …
   ```

5. **Write the file.** Use `write_file` with:
   - `path`: build it by concatenating the literal `OBSIDIAN_VAULT` value
     from the Environment block + `/Daily/` + `<YYYY-MM-DD>.md`. Pass the
     fully-expanded absolute path — never include `$OBSIDIAN_VAULT` or any
     other placeholder syntax in the argument.
   - `mode`: `"overwrite"` (re-running for the same date replaces the note)
   - `createParents`: `true`

6. **Finish.** After `write_file` succeeds, emit one short confirmation
   sentence (e.g. "Wrote 2026-05-23.md, N sessions.") and stop. Do **not**
   ask the user follow-up questions — there is no interactive user;
   anything you ask will hang the job.

## Constraints

- **No graph writes.** Never call `upsert_entries`.
- **One file per run.** Don't create per-session pages or update an index.
- **Empty days still get a note.** If yesterday had no sessions, write
  `# YYYY-MM-DD\n\n_No sessions._\n` so the worklog is a continuous record.
- **Plain prose only.** Don't embed `^<uuid>` citation tokens (those are a
  UI agent convention — useless inside Obsidian).
