/**
 * Provider-agnostic agent-session indexer.
 *
 * Pipeline: provider.scan → classify → segment into spans → upsert nodes.
 *
 *  - Sessions become `AgentSession` nodes.
 *  - Persisted events (user_input / agent_message / file_create / file_edit /
 *    shell_exec / agent_question) become per-type nodes carrying a
 *    `[unspanned, spanned]` state machine. They land as `unspanned` and
 *    transition to `spanned` once a finalised Span claims them.
 *  - Each finalised span becomes a `Span` node referencing its events.
 *    Spans whose trailing event is within HARD_BREAK_MS of `Date.now()`
 *    are deferred (still in-progress). Detection-only events
 *    (`plan_accepted`, `todo_write`) feed segmentation but are not
 *    persisted as nodes — `plan_accepted` is recoverable from
 *    Span.touchedPlans, which the linker job populates from Plan
 *    instances minted by the snapshot-driven plans indexer.
 *  - Span dedup is keyed on `(sessionId, startedAt)` — finalised spans
 *    don't reshape across crawls, so re-running the indexer is idempotent.
 *
 * Span ↔ LSP linking is handled by `spanLink.ts` (separate scheduler job)
 * once the span row exists.
 */

import type { Db, InsertEntry } from '@coffeectx/core';
import { classifyMessages, type ClassifiedEvent } from './classifier.js';
import { computeSpans, SPAN_LINK_EPS_MS, type ComputedSpan } from './spans.js';
import type { AgentLogProvider, ProviderScanOptions } from './provider.js';
import { Progress } from '../jobs/progress.js';
import { extractTitle, resolvePlanLinks } from '../plans/planExtract.js';

function parseMs(iso: string | undefined): number {
  if (!iso) return Date.now();
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? Date.now() : ms;
}

/** Normalize an agent-supplied file path to repo-relative when it sits under
 * repoPath. Claude tool inputs usually give absolute paths; LSP `file_path`
 * is always repo-relative, so Span.filesChanged must match that shape for
 * spanLink to find anything. Paths outside the repo (config, plans) and
 * already-relative paths pass through unchanged. */
function relativizePath(p: string, repoPath: string | undefined): string {
  if (!repoPath || !p) return p;
  const root = repoPath.endsWith('/') ? repoPath.slice(0, -1) : repoPath;
  if (p === root) return '';
  if (p.startsWith(root + '/')) return p.slice(root.length + 1);
  return p;
}

export interface IndexLogsOptions extends ProviderScanOptions {
  /** Repo root used to relativize agent-supplied file paths so Span.filesChanged
   * matches LSP `file_path` (which is always repo-relative). Paths outside the
   * repo pass through unchanged. */
  repoPath?: string;
  /**
   * Wall-clock anchor for the hard-break gate inside `computeSpans`.
   * Defaults to `Date.now()` for production daemon runs; replay/test
   * harnesses override it so spans close deterministically regardless of
   * how much real time has passed since the captured session.
   */
  closeBeforeMs?: number;
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
  const closeBeforeMs = options.closeBeforeMs ?? Date.now();
  const spansBySession = new Map<string, ComputedSpan[]>();
  for (const [sid, evs] of eventsBySession) {
    spansBySession.set(sid, computeSpans(evs, closeBeforeMs));
  }
  const totalSpans = [...spansBySession.values()].reduce((a, b) => a + b.length, 0);
  console.log(`[${provider.name}] computed ${totalSpans} finalised span(s)`);

  // ── Existing-row preload ───────────────────────────────────────────────────
  // For events we map UUID → node id so spans can reference already-inserted
  // events via `$id` (cross-crawl case: events landed unspanned in an earlier
  // crawl, span finalises in a later one).
  const existingEventIdByUuid = loadExistingEventIds(db);
  const existingSessionIds = loadExistingSessionIds(db);
  // Dedup spans by `(sessionId, startedAt)`. Finalised spans don't reshape
  // across crawls so this is sufficient — never re-emit a span whose key is
  // already in DB.
  const existingSpanKeys = loadExistingSpanKeys(db);
  // Codex `<proposed_plan>` extraction emits a Plan node with a synthetic
  // path `codex-plan:<sessionId>:<uuid>`. Build a set of already-present
  // synthetic paths so re-imports are idempotent (Plan nodes don't have a
  // version timeline; without dedup, every re-run would mint a duplicate).
  const existingCodexPlanPaths = loadExistingCodexPlanPaths(db);

  if (events.length === 0 && scanned.sessions.size === 0) return result;

  // ── Build the entry batch ──────────────────────────────────────────────────
  const entries: InsertEntry[] = [];

  // 1) AgentSession rows.
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

  // 2) Event rows. Track per-uuid batch index so spans built in step 3 can
  //    cross-reference newly-inserted events via `$ref`.
  const newEventBatchIndexByUuid = new Map<string, number>();

  // UUIDs of events that any finalised span claims — only these AgentMessage
  // entries get isSummary, only these events get a state on insert.
  const summaryUuids = new Set<string>();
  for (const spans of spansBySession.values()) {
    for (const span of spans) {
      const ev = span.events[span.summaryIndex];
      if (ev && ev.kind === 'agent_message') summaryUuids.add(ev.uuid);
    }
  }

  for (const [, sessionEvents] of eventsBySession) {
    for (const event of sessionEvents) {
      // `plan_accepted` and `todo_write` are in-memory signals that feed the
      // span heuristics (SPLIT_WEIGHTS in spanHeuristics.ts) but are NOT
      // persisted as rows — acceptance is recoverable via Span ↔ Plan
      // linkage instead.
      if (event.kind === 'plan_accepted') continue;
      if (event.kind === 'todo_write') continue;
      // `plan_proposed` becomes a Plan node, not a per-event row. Handled
      // in the dedicated async pass below so DB-driven link resolution can
      // happen.
      if (event.kind === 'plan_proposed') continue;
      if (existingEventIdByUuid.has(event.uuid)) continue;
      const entry = eventToInsertEntry(event, summaryUuids.has(event.uuid));
      if (entry) {
        newEventBatchIndexByUuid.set(event.uuid, entries.length);
        entries.push(entry);
      }
    }
  }

  // 2b) Plan rows from `plan_proposed` events (codex extracts plans from
  //     assistant-message markup; see classifier's PROPOSED_PLAN_RE).
  for (const [, sessionEvents] of eventsBySession) {
    for (const event of sessionEvents) {
      if (event.kind !== 'plan_proposed') continue;
      const planPath = codexPlanPath(event.sessionId, event.uuid);
      if (existingCodexPlanPaths.has(planPath)) continue;
      const content = event.text ?? '';
      if (!content.trim()) continue;
      const title = extractTitle(content);
      const { filePaths, symbolRefs } = await resolvePlanLinks(content, db);
      entries.push({
        type: 'Plan',
        data: {
          name: codexPlanName(event.sessionId, title),
          path: planPath,
          content,
          ...(title ? { title } : {}),
          relatedFiles: filePaths,
          relatedSymbols: symbolRefs,
        },
        createdAt: parseMs(event.timestamp),
        updatedAt: parseMs(event.timestamp),
      });
      existingCodexPlanPaths.add(planPath);
    }
  }

  // 3) Span rows. Skip ones whose `(sessionId, startedAt)` key is already in DB.
  //    For each message, prefer the batch `$ref` (newly inserted in this run)
  //    falling back to the existing node's `$id` (inserted in a previous run).
  const spansBatchIndices: number[] = []; // entry indices that are Span entries
  const spanByBatchIndex = new Map<number, ComputedSpan>();
  for (const spans of spansBySession.values()) {
    for (let i = 0; i < spans.length; i++) {
      const span = spans[i]!;
      const sid = span.events[0]!.sessionId;
      const spanKey = `${sid}|${span.startedAtMs}`;
      if (existingSpanKeys.has(spanKey)) continue;
      const nextStart = i + 1 < spans.length ? spans[i + 1]!.startedAtMs : undefined;
      const effectiveEnd = computeEffectiveEnd(span.endedAtMs, nextStart);

      const messageRefs: Array<{ $ref: number } | { $id: string }> = [];
      for (const ev of span.events) {
        const newIdx = newEventBatchIndexByUuid.get(ev.uuid);
        if (newIdx !== undefined) {
          messageRefs.push({ $ref: newIdx });
          continue;
        }
        const existingId = existingEventIdByUuid.get(ev.uuid);
        if (existingId) messageRefs.push({ $id: existingId });
      }
      if (messageRefs.length === 0) continue;

      const summaryRef = (() => {
        const ev = span.events[span.summaryIndex];
        if (!ev || ev.kind !== 'agent_message') return undefined;
        const newIdx = newEventBatchIndexByUuid.get(ev.uuid);
        if (newIdx !== undefined) return { $ref: newIdx };
        const existingId = existingEventIdByUuid.get(ev.uuid);
        return existingId ? { $id: existingId } : undefined;
      })();

      const filesChanged = new Set<string>();
      for (const ev of span.events) {
        if (ev.kind === 'file_create' || ev.kind === 'file_edit') {
          if (ev.path) filesChanged.add(relativizePath(ev.path, options.repoPath));
        }
      }
      const data: Record<string, unknown> = {
        sessionId: sid,
        kind: span.kind,
        startedAt: String(span.startedAtMs),
        endedAt: String(span.endedAtMs),
        effectiveEnd: String(effectiveEnd),
        messages: messageRefs,
        filesChanged: [...filesChanged],
        touchedSymbols: [],
        touchedPlans: [],
      };
      if (summaryRef) data.summary = summaryRef;
      const batchIdx = entries.length;
      spansBatchIndices.push(batchIdx);
      spanByBatchIndex.set(batchIdx, span);
      entries.push({ type: 'Span', data, createdAt: span.startedAtMs });
      existingSpanKeys.add(spanKey);
    }
  }

  if (entries.length === 0) {
    console.log(`[${provider.name}] no new entries to insert`);
    return result;
  }

  // ── Insert in one batch (preserves $ref ordering) ─────────────────────────
  const insertResult = await db.insertEntries(entries);
  result.inserted = insertResult.ids.filter(id => id !== null).length;
  result.spans = spansBatchIndices.length;
  result.events = newEventBatchIndexByUuid.size;
  for (const err of insertResult.errors) {
    const msg = `entry ${err.index}${err.path ? `.${err.path}` : ''}: ${err.message}`;
    console.error(`[${provider.name}] ${msg}`);
  }

  // Print a tiny progress line for parity with the previous output.
  new Progress(`${provider.name}:insert`, entries.length).done(`${result.inserted} inserted`);

  // ── State bumps: every event referenced by a freshly-emitted Span flips
  //     `unspanned → spanned`. setNodeState is idempotent (no-op when
  //     already at target) so re-running over a stable session is cheap.
  //     We resolve event uuids → node ids via the combined map of
  //     newly-inserted (from insertResult) plus pre-existing event ids.
  const spannedNodeIds = new Set<string>();
  for (const spanIdx of spansBatchIndices) {
    if (insertResult.ids[spanIdx] == null) continue;
    const data = (entries[spanIdx]!.data as Record<string, unknown>);
    const refs = data.messages as Array<{ $ref?: number; $id?: string }>;
    for (const ref of refs) {
      let nodeId: string | undefined;
      if (typeof ref.$ref === 'number') nodeId = insertResult.ids[ref.$ref] ?? undefined;
      else if (typeof ref.$id === 'string') nodeId = ref.$id;
      if (nodeId) spannedNodeIds.add(nodeId);
    }
  }
  for (const nodeId of spannedNodeIds) {
    try { db.setNodeState(nodeId, 'spanned'); } catch { /* node missing / no machine */ }
  }

  // ── Debug instrumentation: stash boundary scoring on each emitted Span.
  //     NOOP when `config.debug = false`. Lets the tuner see exactly which
  //     signals fired (or didn't) at every boundary the cut algorithm saw.
  for (const spanIdx of spansBatchIndices) {
    const spanId = insertResult.ids[spanIdx];
    if (!spanId) continue;
    const span = spanByBatchIndex.get(spanIdx);
    if (!span) continue;
    db.debugSet(spanId, 'spanScoring', buildSpanScoringPayload(span));
  }

  // ── Catch-up pass: re-segment unspanned tails already in DB ───────────────
  //   The provider scans JSONL files via mtime/hash; when no new bytes are
  //   appended (idle conversation) it returns nothing, so the main flow
  //   above does no work — but a trailing tail may have aged past
  //   HARD_BREAK_MS and is now ready to finalise. This pass operates
  //   purely on `state='unspanned'` rows in DB, so it always runs.
  const catchUpResult = await catchUpUnspannedTails(db, closeBeforeMs, existingSpanKeys, provider.name, options.repoPath);
  result.spans += catchUpResult.spans;
  // `events` counter is incremented as we transition events to `spanned`;
  // the row count change is reflected in `catchUpResult.eventsBumped`.

  return result;
}

function eventToInsertEntry(event: ClassifiedEvent, isSummary: boolean): InsertEntry | null {
  const createdAt = parseMs(event.timestamp);
  const state = 'unspanned';
  switch (event.kind) {
    case 'user_input':
      return {
        type: 'UserInput',
        data: {
          sessionId: event.sessionId,
          uuid: event.uuid,
          text: event.text ?? '',
        },
        createdAt, state,
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
        createdAt, state,
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
        createdAt, state,
      };

    case 'agent_question':
      return {
        type: 'AgentQuestion',
        data: {
          sessionId: event.sessionId,
          uuid: event.uuid,
          question: event.question ?? '',
        },
        createdAt, state,
      };

    case 'agent_message': {
      const data: Record<string, unknown> = {
        sessionId: event.sessionId,
        uuid: event.uuid,
        text: event.text ?? '',
      };
      if (isSummary) data.isSummary = 'true';
      return { type: 'AgentMessage', data, createdAt, state };
    }

    default:
      return null;
  }
}

const EVENT_TYPES = ['UserInput', 'FileOperation', 'ShellExecution', 'AgentQuestion', 'AgentMessage'];

/** uuid → node id for every persisted event currently in DB. */
function loadExistingEventIds(db: Db): Map<string, string> {
  const out = new Map<string, string>();
  for (const id of db.queryByNamedType(EVENT_TYPES)) {
    const fieldId = db.getMapFieldId(id, 'uuid');
    if (!fieldId) continue;
    const node = db.loadNode(fieldId);
    if (node.kind === 'atom' && node.atom.kind === 'symbol') out.set(node.atom.value, id);
  }
  return out;
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

/** Set of `codex-plan:<sessionId>:<uuid>` paths already minted by previous
 *  runs, used to dedup `plan_proposed` event emission. */
function loadExistingCodexPlanPaths(db: Db): Set<string> {
  const out = new Set<string>();
  for (const mapId of db.queryByNamedType(['Plan'])) {
    const fid = db.getMapFieldId(mapId, 'path');
    if (!fid) continue;
    const node = db.loadNode(fid);
    if (node.kind === 'atom' && node.atom.kind === 'symbol' && node.atom.value.startsWith('codex-plan~')) {
      out.add(node.atom.value);
    }
  }
  return out;
}

/** Synthetic path for a codex-extracted plan — keyed by session + message
 *  uuid so re-imports of the same rollout are idempotent. `~` separates
 *  the two parts (neither sessionId nor uuid contain that character; both
 *  the synthetic codex `codex:<id>:line:N` uuid format and the bare
 *  `codex:<id>` session id are full of colons, so colon as delimiter
 *  would be ambiguous when the linker later splits the path). */
function codexPlanPath(sessionId: string, uuid: string): string {
  return `codex-plan~${sessionId}~${uuid}`;
}

/** Human-readable Plan `name` field — short session-tagged title slug. */
function codexPlanName(sessionId: string, title: string | null): string {
  const sidTail = sessionId.replace(/^codex:/, '').slice(0, 8);
  const slug = (title ?? 'untitled')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `codex-${sidTail}-${slug || 'untitled'}`;
}

/**
 * Re-segment any `unspanned` events still in DB and emit Spans for the
 * batches that have aged past `HARD_BREAK_MS`. Operates independently of
 * the JSONL provider — runs even when the file hasn't changed since the
 * last crawl.
 *
 * Returns metrics for the run-log line. `existingSpanKeys` is mutated as
 * we emit so the same span isn't queued twice in the same crawl.
 */
async function catchUpUnspannedTails(
  db: Db,
  closeBeforeMs: number,
  existingSpanKeys: Set<string>,
  providerName: string,
  repoPath: string | undefined,
): Promise<{ spans: number; eventsBumped: number }> {
  const result = { spans: 0, eventsBumped: 0 };
  const raw = db.findUnspannedEvents();
  if (raw.length === 0) return result;

  // Group rows by session and project to ClassifiedEvent shape so we can
  // reuse computeSpans without re-classifying. Lost signals (postToolResult,
  // todo_write, plan_accepted) aren't reconstructable from DB rows, but
  // for trailing tails the primary cuts (UserInput, gaps, done-keywords)
  // still trigger correctly.
  const idByUuid = new Map<string, string>();
  const eventsBySession = new Map<string, ClassifiedEvent[]>();
  for (const r of raw) {
    idByUuid.set(r.uuid, r.id);
    const evt: ClassifiedEvent = {
      kind: r.kind,
      sessionId: r.sessionId,
      uuid: r.uuid,
      timestamp: new Date(r.createdAt).toISOString(),
      ...(r.text ? { text: r.text } : {}),
      ...(r.path ? { path: r.path } : {}),
      ...(r.content ? { content: r.content } : {}),
      ...(r.command ? { command: r.command } : {}),
      ...(r.description ? { description: r.description } : {}),
      ...(r.question ? { question: r.question } : {}),
    };
    const arr = eventsBySession.get(r.sessionId) ?? [];
    arr.push(evt);
    eventsBySession.set(r.sessionId, arr);
  }

  const entries: InsertEntry[] = [];
  const spanBatchIndices: number[] = [];
  const spanByBatchIndex = new Map<number, ComputedSpan>();
  for (const [sid, evs] of eventsBySession) {
    const spans = computeSpans(evs, closeBeforeMs);
    for (let i = 0; i < spans.length; i++) {
      const span = spans[i]!;
      const spanKey = `${sid}|${span.startedAtMs}`;
      if (existingSpanKeys.has(spanKey)) continue;
      const messageRefs: Array<{ $id: string }> = [];
      for (const ev of span.events) {
        const nodeId = idByUuid.get(ev.uuid);
        if (nodeId) messageRefs.push({ $id: nodeId });
      }
      if (messageRefs.length === 0) continue;
      const nextStart = i + 1 < spans.length ? spans[i + 1]!.startedAtMs : undefined;
      const effectiveEnd = computeEffectiveEnd(span.endedAtMs, nextStart);
      const summary = (() => {
        const ev = span.events[span.summaryIndex];
        if (!ev || ev.kind !== 'agent_message') return undefined;
        const nodeId = idByUuid.get(ev.uuid);
        return nodeId ? { $id: nodeId } : undefined;
      })();
      const filesChanged = new Set<string>();
      for (const ev of span.events) {
        if (ev.kind === 'file_create' || ev.kind === 'file_edit') {
          if (ev.path) filesChanged.add(relativizePath(ev.path, repoPath));
        }
      }
      const data: Record<string, unknown> = {
        sessionId: sid,
        kind: span.kind,
        startedAt: String(span.startedAtMs),
        endedAt: String(span.endedAtMs),
        effectiveEnd: String(effectiveEnd),
        messages: messageRefs,
        filesChanged: [...filesChanged],
        touchedSymbols: [],
        touchedPlans: [],
      };
      if (summary) data.summary = summary;
      const batchIdx = entries.length;
      spanBatchIndices.push(batchIdx);
      spanByBatchIndex.set(batchIdx, span);
      entries.push({ type: 'Span', data, createdAt: span.startedAtMs });
      existingSpanKeys.add(spanKey);
    }
  }

  if (entries.length === 0) return result;

  const ir = await db.insertEntries(entries);
  for (const err of ir.errors) {
    console.error(`[${providerName}] catch-up: entry ${err.index}${err.path ? `.${err.path}` : ''}: ${err.message}`);
  }
  result.spans = spanBatchIndices.filter(i => ir.ids[i] != null).length;

  // Transition every event that just got claimed by a Span + stash debug.
  for (const i of spanBatchIndices) {
    const spanId = ir.ids[i];
    if (spanId == null) continue;
    const data = entries[i]!.data as Record<string, unknown>;
    const refs = data.messages as Array<{ $id: string }>;
    for (const ref of refs) {
      try { db.setNodeState(ref.$id, 'spanned'); result.eventsBumped++; }
      catch { /* node missing / no machine */ }
    }
    const span = spanByBatchIndex.get(i);
    if (span) db.debugSet(spanId, 'spanScoring', buildSpanScoringPayload(span));
  }

  if (result.spans > 0) {
    console.log(`[${providerName}] catch-up: emitted ${result.spans} span(s), bumped ${result.eventsBumped} event(s) to spanned`);
  }
  return result;
}

/** Per-span linker-side upper bound: `endedAt + SPAN_LINK_EPS_MS`, but never
 *  past the start of the next span in the same session. Lets the linker
 *  absorb mtime / event-time skew without bleeding into a follow-up span. */
function computeEffectiveEnd(endedAtMs: number, nextSpanStartMs: number | undefined): number {
  const padded = endedAtMs + SPAN_LINK_EPS_MS;
  return nextSpanStartMs == null ? padded : Math.min(padded, nextSpanStartMs);
}

/** Shape we stash under `node_debug_info.spanScoring` for each emitted Span.
 *  Carries the surrounding cut decisions and every internal boundary's
 *  signal breakdown so the tuner can reconstruct the segmentation
 *  reasoning without re-running computeSpans. */
function buildSpanScoringPayload(span: ComputedSpan): Record<string, unknown> {
  return {
    kind: span.kind,
    startedAt: span.startedAtMs,
    endedAt: span.endedAtMs,
    openingBoundary: span.openingBoundary ?? null,
    closingBoundary: span.closingBoundary ?? null,
    internalBoundaries: span.boundaries,
  };
}

/** "<sessionId>|<startedAtMs>" for every Span node currently in DB. */
function loadExistingSpanKeys(db: Db): Set<string> {
  const out = new Set<string>();
  for (const mapId of db.queryByNamedType(['Span'])) {
    const sidFieldId = db.getMapFieldId(mapId, 'sessionId');
    const startedFieldId = db.getMapFieldId(mapId, 'startedAt');
    if (!sidFieldId || !startedFieldId) continue;
    const sidNode = db.loadNode(sidFieldId);
    const startedNode = db.loadNode(startedFieldId);
    if (sidNode.kind !== 'atom' || sidNode.atom.kind !== 'symbol') continue;
    if (startedNode.kind !== 'atom' || startedNode.atom.kind !== 'symbol') continue;
    out.add(`${sidNode.atom.value}|${startedNode.atom.value}`);
  }
  return out;
}
