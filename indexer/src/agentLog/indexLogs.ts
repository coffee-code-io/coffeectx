/**
 * Provider-agnostic agent-session indexer.
 *
 * Pipeline: provider.scan → classify → segment into spans → upsert nodes.
 *
 *  - Sessions become `AgentSession` nodes.
 *  - Persisted events (user_input / agent_message / file_create / file_edit /
 *    shell_exec / agent_question) become per-type nodes. The terminating
 *    AgentMessage of each span gets `isSummary="true"` set.
 *  - Each span becomes a `Span` node referencing its events. Detection-only
 *    events (`plan_accepted`, `todo_write`) feed segmentation but are not
 *    persisted as nodes. `plan_accepted` still flows into the
 *    `plan_acceptances` hidden table so plans can backref to sessions.
 *
 * Span ↔ LSP linking is handled by `spanLink.ts` (separate scheduler job)
 * once the span row exists.
 */

import type { Db, InsertEntry } from '@coffeectx/core';
import { classifyMessages, type ClassifiedEvent } from './classifier.js';
import { computeSpans, type ComputedSpan } from './spans.js';
import type { AgentLogProvider, ProviderScanOptions } from './provider.js';
import { Progress } from '../jobs/progress.js';

function parseMs(iso: string | undefined): number {
  if (!iso) return Date.now();
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? Date.now() : ms;
}

export interface IndexLogsOptions extends ProviderScanOptions {
  /** Reserved for future LSP-linking convenience. Currently unused. */
  repoPath?: string;
}

export interface IndexLogsResult {
  files: number;
  skipped: number;
  sessions: number;
  events: number;
  spans: number;
  inserted: number;
  errors: Array<{ file: string; error: string; stack?: string }>;
}

export async function indexAgentSessions(
  db: Db,
  provider: AgentLogProvider,
  options: IndexLogsOptions = {},
): Promise<IndexLogsResult> {
  const result: IndexLogsResult = {
    files: 0, skipped: 0, sessions: 0, events: 0, spans: 0, inserted: 0, errors: [],
  };

  let scanned;
  try {
    scanned = await provider.scan(options);
  } catch (err) {
    result.errors.push({
      file: provider.name,
      error: (err as Error).message,
      stack: (err as Error).stack,
    });
    return result;
  }

  result.sessions = scanned.sessions.size;

  const allEvents = classifyMessages(scanned.messages);
  const events = options.newerThan
    ? allEvents.filter(e => new Date(e.timestamp) >= options.newerThan!)
    : allEvents;
  console.log(
    `[${provider.name}] classified ${events.length} events ` +
    `from ${scanned.messages.length} messages (${scanned.sessions.size} sessions)`,
  );

  // ── Span segmentation ──────────────────────────────────────────────────────
  // Group events by session so segmentation only sees one session at a time —
  // a long quiet gap *between* sessions shouldn't count as inactivity.
  const eventsBySession = new Map<string, ClassifiedEvent[]>();
  for (const ev of events) {
    const arr = eventsBySession.get(ev.sessionId) ?? [];
    arr.push(ev);
    eventsBySession.set(ev.sessionId, arr);
  }
  const spansBySession = new Map<string, ComputedSpan[]>();
  for (const [sid, evs] of eventsBySession) {
    spansBySession.set(sid, computeSpans(evs));
  }
  const totalSpans = [...spansBySession.values()].reduce((a, b) => a + b.length, 0);
  console.log(`[${provider.name}] computed ${totalSpans} span(s)`);

  // ── Existing-row preload ───────────────────────────────────────────────────
  const existingUuids = loadExistingUuids(db);
  const existingSessionIds = loadExistingSessionIds(db);

  if (events.length === 0 && scanned.sessions.size === 0) return result;

  // ── Build the entry batch ──────────────────────────────────────────────────
  // 1) AgentSession rows.
  const entries: InsertEntry[] = [];
  for (const meta of scanned.sessions.values()) {
    if (existingSessionIds.has(meta.sessionId)) continue;
    entries.push({
      type: 'AgentSession',
      data: {
        sessionId: meta.sessionId,
        projectPath: meta.cwd ?? '',
        model: meta.model ?? '',
        provider: meta.provider,
      },
      createdAt: parseMs(meta.startTime),
    });
    existingSessionIds.add(meta.sessionId);
  }

  // 2) Event rows. Track per-event entry index so we can resolve $ids on Span
  //    construction. Use uuid as the cross-reference key.
  const eventIndexByUuid = new Map<string, number>();
  const planAcceptances: Array<{ planSlug: string; sessionId: string; timestamp: string }> = [];

  // Build a map of "which UUIDs need isSummary=true". Computed across all
  // spans before emission so the corresponding UserInput/etc. entries don't
  // pick up the flag — only AgentMessage rows do.
  const summaryUuids = new Set<string>();
  for (const spans of spansBySession.values()) {
    for (const span of spans) {
      const ev = span.events[span.summaryIndex];
      if (ev && ev.kind === 'agent_message') summaryUuids.add(ev.uuid);
    }
  }

  // Stream events in their session-ordered position so AgentMessage rows
  // land in the same order they appear in the log.
  for (const [, sessionEvents] of eventsBySession) {
    for (const event of sessionEvents) {
      if (event.kind === 'plan_accepted') {
        if (event.planSlug) {
          planAcceptances.push({
            planSlug: event.planSlug,
            sessionId: event.sessionId,
            timestamp: event.timestamp,
          });
        }
        continue;
      }
      if (event.kind === 'todo_write') continue;
      if (existingUuids.has(event.uuid)) continue;
      const entry = eventToInsertEntry(event, summaryUuids.has(event.uuid));
      if (entry) {
        eventIndexByUuid.set(event.uuid, entries.length);
        entries.push(entry);
        existingUuids.add(event.uuid);
      }
    }
  }

  // 3) Span rows. Reference the event rows by $ref in this same batch.
  for (const spans of spansBySession.values()) {
    for (const span of spans) {
      const messageRefs: Array<{ $ref: number } | { $id: string }> = [];
      for (const ev of span.events) {
        const idx = eventIndexByUuid.get(ev.uuid);
        if (idx !== undefined) messageRefs.push({ $ref: idx });
      }
      if (messageRefs.length === 0) continue;
      const summaryRef = (() => {
        const ev = span.events[span.summaryIndex];
        if (!ev || ev.kind !== 'agent_message') return undefined;
        const idx = eventIndexByUuid.get(ev.uuid);
        return idx !== undefined ? { $ref: idx } : undefined;
      })();
      const filesChanged = new Set<string>();
      for (const ev of span.events) {
        if (ev.kind === 'file_create' || ev.kind === 'file_edit') {
          if (ev.path) filesChanged.add(ev.path);
        }
      }
      const data: Record<string, unknown> = {
        sessionId: span.events[0]!.sessionId,
        kind: span.kind,
        startedAt: String(span.startedAtMs),
        endedAt: String(span.endedAtMs),
        messages: messageRefs,
        filesChanged: [...filesChanged],
        touchedSymbols: [],
      };
      if (summaryRef) data.summary = summaryRef;
      entries.push({ type: 'Span', data, createdAt: span.startedAtMs });
    }
  }

  if (entries.length === 0) {
    console.log(`[${provider.name}] no new entries to insert`);
    return result;
  }

  // ── Insert in batches ──────────────────────────────────────────────────────
  // Spans cross-reference their events via $ref, so we can't split spans into
  // a separate batch — keep the whole payload together. Batches stay small by
  // chunking sessions, but here we insert in one go to preserve $ref indices.
  const insertResult = await db.insertEntries(entries);
  result.inserted = insertResult.ids.filter(id => id !== null).length;
  result.spans = entries.filter(e => e.type === 'Span').length;
  result.events = eventIndexByUuid.size;
  for (const err of insertResult.errors) {
    const msg = `entry ${err.index}${err.path ? `.${err.path}` : ''}: ${err.message}`;
    console.error(`[${provider.name}] ${msg}`);
  }

  // Print a tiny progress line for parity with the previous output.
  new Progress(`${provider.name}:insert`, entries.length).done(`${result.inserted} inserted`);

  if (planAcceptances.length > 0) {
    for (const pa of planAcceptances) {
      db.writePlanAcceptance(pa.planSlug, pa.sessionId, pa.timestamp);
    }
    console.log(`[${provider.name}] wrote ${planAcceptances.length} plan_acceptances rows`);
  }

  return result;
}

function eventToInsertEntry(event: ClassifiedEvent, isSummary: boolean): InsertEntry | null {
  const createdAt = parseMs(event.timestamp);
  switch (event.kind) {
    case 'user_input':
      return {
        type: 'UserInput',
        data: {
          sessionId: event.sessionId,
          uuid: event.uuid,
          text: event.text ?? '',
        },
        createdAt,
      };

    case 'file_create':
    case 'file_edit':
      return {
        type: 'FileOperation',
        data: {
          sessionId: event.sessionId,
          uuid: event.uuid,
          operation: event.kind === 'file_create' ? 'create' : 'edit',
          path: event.path ?? '',
          content: event.content ?? '',
        },
        createdAt,
      };

    case 'shell_exec':
      return {
        type: 'ShellExecution',
        data: {
          sessionId: event.sessionId,
          uuid: event.uuid,
          command: event.command ?? '',
          description: event.description ?? '',
        },
        createdAt,
      };

    case 'agent_question':
      return {
        type: 'AgentQuestion',
        data: {
          sessionId: event.sessionId,
          uuid: event.uuid,
          question: event.question ?? '',
        },
        createdAt,
      };

    case 'agent_message': {
      const data: Record<string, unknown> = {
        sessionId: event.sessionId,
        uuid: event.uuid,
        text: event.text ?? '',
      };
      if (isSummary) data.isSummary = 'true';
      return { type: 'AgentMessage', data, createdAt };
    }

    default:
      return null;
  }
}

const EVENT_TYPES = ['UserInput', 'FileOperation', 'ShellExecution', 'AgentQuestion', 'AgentMessage'];

function loadExistingUuids(db: Db): Set<string> {
  const uuids = new Set<string>();
  for (const id of db.queryByNamedType(EVENT_TYPES)) {
    const fieldId = db.getMapFieldId(id, 'uuid');
    if (!fieldId) continue;
    const node = db.loadNode(fieldId);
    if (node.kind === 'atom' && node.atom.kind === 'symbol') uuids.add(node.atom.value);
  }
  return uuids;
}

function loadExistingSessionIds(db: Db): Set<string> {
  const ids = new Set<string>();
  for (const mapId of db.queryByNamedType(['AgentSession'])) {
    const fieldId = db.getMapFieldId(mapId, 'sessionId');
    if (!fieldId) continue;
    const node = db.loadNode(fieldId);
    if (node.kind === 'atom' && node.atom.kind === 'symbol') ids.add(node.atom.value);
  }
  return ids;
}
