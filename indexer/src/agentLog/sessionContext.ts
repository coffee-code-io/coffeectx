/**
 * Per-event file-context computation.
 *
 * For each text event (`UserInput`, `AgentMessage`, `AgentSummary`,
 * `AgentQuestion`) in a session, picks the **nearest** `Write`/`Edit` tool
 * call to define the file the event is "about". The session is the indexer's
 * own grouping (one Claude / Codex / pi.dev session), already chronologically
 * ordered by the classifier.
 *
 * Heuristic (user-approved):
 *   - Boundaries are only `file_create` / `file_edit` events. Read / Glob /
 *     Grep tool calls do NOT count — they're too noisy.
 *   - For each text event T, the nearest edit is picked, preferring an edit
 *     with `timestamp >= T.timestamp` (i.e. "what edit was this leading up
 *     to"). Falls back to the most recent prior edit when there is no later
 *     one (the typical case for the trailing AgentSummary).
 *   - Sessions with zero Write/Edit events produce no entries — every text
 *     event gets an empty file-context and is dropped by the enricher.
 *
 * Returns: Map keyed by `event.uuid` (which is what gets stored as the event
 * node's `uuid` symbol field; the consumer translates this to the inserted
 * node id when writing rows to `event_file_context`).
 */

import type { ClassifiedEvent, EventKind } from './classifier.js';

const TEXT_KINDS = new Set<EventKind>([
  'user_input',
  'agent_message',
  'agent_summary',
  'agent_question',
]);

const EDIT_KINDS = new Set<EventKind>(['file_create', 'file_edit']);

/**
 * Compute file-context entries for ALL events across ALL sessions.
 * Events are partitioned by their `sessionId` (already provider-namespaced as
 * `claude:<uuid>` / `codex:<thread>` / `pi:<uuid>` by the providers).
 *
 * Returns a flat array suitable for `db.writeEventFileContext` after the
 * caller maps each event's uuid to its inserted node id.
 */
export function computeFileContext(events: ClassifiedEvent[]): Map<string, string[]> {
  const out = new Map<string, string[]>();

  // Bucket events by session, preserving chronological order.
  const bySession = new Map<string, ClassifiedEvent[]>();
  for (const e of events) {
    const arr = bySession.get(e.sessionId) ?? [];
    arr.push(e);
    bySession.set(e.sessionId, arr);
  }

  for (const sessionEvents of bySession.values()) {
    sessionEvents.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const edits = sessionEvents.filter(e => EDIT_KINDS.has(e.kind) && !!e.path);
    if (edits.length === 0) continue;

    for (const ev of sessionEvents) {
      if (!TEXT_KINDS.has(ev.kind)) continue;
      const file = pickNearestEditPath(edits, ev.timestamp);
      if (file) out.set(ev.uuid, [file]);
    }
  }

  return out;
}

/**
 * Pick the edit whose timestamp is closest to `ts`. Ties are broken in favour
 * of an edit AT or AFTER `ts` (so a text event that immediately precedes an
 * edit gets attached to that edit, matching how users actually narrate work).
 */
function pickNearestEditPath(edits: ClassifiedEvent[], ts: string): string | null {
  let bestAfter: { dt: number; path: string } | null = null;
  let bestBefore: { dt: number; path: string } | null = null;
  const eventTs = Date.parse(ts);
  if (Number.isNaN(eventTs)) return edits[0]?.path ?? null;

  for (const e of edits) {
    if (!e.path) continue;
    const editTs = Date.parse(e.timestamp);
    if (Number.isNaN(editTs)) continue;
    const dt = editTs - eventTs;
    if (dt >= 0) {
      if (!bestAfter || dt < bestAfter.dt) bestAfter = { dt, path: e.path };
    } else {
      const absDt = -dt;
      if (!bestBefore || absDt < bestBefore.dt) bestBefore = { dt: absDt, path: e.path };
    }
  }

  return bestAfter?.path ?? bestBefore?.path ?? null;
}
