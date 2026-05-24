import type { Db, DeepNode, AuthSettings } from '@coffeectx/core';
import { formatDeepNode } from '@coffeectx/core';
import { runSkillInteractive, type BatchPayload } from './runSkill.js';

/**
 * Named types that represent indexable agent-log events. Each row is a
 * candidate batch item for skill jobs. AgentSummary is one-per-session and
 * carries the ai-title — included so skills can attach the title to the
 * session context.
 */
const EVENT_TYPES = ['UserInput', 'FileOperation', 'ShellExecution', 'AgentQuestion', 'AgentMessage', 'AgentSummary'];

interface EventSnapshot {
  id: string;
  timestamp: string;
  sessionId: string;
  typeName: string;
  summary: unknown;
}

/** Extract a symbol string value from a DeepNode field. */
function getSymbolValue(node: DeepNode | undefined): string | undefined {
  if (!node || node.kind !== 'atom') return undefined;
  if (node.atom.kind !== 'symbol') return undefined;
  return node.atom.value;
}

/** Split a sorted event list into batches of `batchStep` events. */
interface BuiltBatch {
  payload: BatchPayload;
  eventIds: string[];
}

function buildBatches(events: EventSnapshot[], batchStep: number): BuiltBatch[] {
  const batches: BuiltBatch[] = [];
  for (let i = 0; i < events.length; i += batchStep) {
    const group = events.slice(i, i + batchStep);
    batches.push({
      payload: { events: group.map(e => e.summary) },
      eventIds: group.map(e => e.id),
    });
  }
  return batches;
}

// ── Single-skill executor (used by the per-skill scheduler jobs) ─────────────

export interface RunOneSkillOptions {
  db: Db;
  /** Active project name (used to namespace persisted pi sessions). */
  projectName: string;
  /** Job-name slug. Used as the persisted session-id and progress key. */
  skillName: string;
  /** Pre-loaded prompt body — the agent's instructions for each batch. */
  prompt: string;
  /** Event IDs already processed in prior runs of this skill. */
  processedEventIds: ReadonlySet<string>;
  /**
   * Called after each batch completes, with the IDs newly marked as processed.
   * Use this to persist progress (e.g. to `jobs.state_json`).
   */
  onBatchProcessed?: (newlyProcessedIds: string[]) => Promise<void> | void;
  batchStep?: number;
  /** Whether the agent is allowed to call the `upsert_entries` tool. */
  allowInsert?: boolean;
  /** LLM auth for this run (typically from project.jobs[name].parameters.auth). */
  auth?: AuthSettings;
  /** Scheduler abort signal — propagated to runSkillInteractive. */
  signal?: AbortSignal;
}

export interface RunOneSkillResult {
  batches: number;
  sessions: number;
  events: number;
  errors: Array<{ error: string }>;
}

/**
 * Load all new (unprocessed) log events grouped by sessionId, sorted by timestamp.
 */
function loadNewEventsGroupedBySession(
  db: Db,
  processed: ReadonlySet<string>,
): { sessions: Map<string, EventSnapshot[]>; total: number; skipped: number } {
  const allEventIds = db.queryByNamedType(EVENT_TYPES);
  const sessions = new Map<string, EventSnapshot[]>();
  let skipped = 0;

  for (const id of allEventIds) {
    if (processed.has(id)) { skipped++; continue; }
    try {
      const typeName = db.getNodeTypeName(id) ?? 'unknown';
      const node = db.loadNodeDeep(id, 1);
      if (node.kind !== 'map') continue;

      const sessionId = getSymbolValue(node.entries['sessionId']);
      if (!sessionId) continue;

      // AgentSummary has no timestamp; use empty string so it sorts first
      // within the session (it's a session-level header).
      const timestamp = getSymbolValue(node.entries['timestamp']) ?? '';
      const snap: EventSnapshot = { id, timestamp, sessionId, typeName, summary: formatDeepNode(node) };
      if (!sessions.has(sessionId)) sessions.set(sessionId, []);
      sessions.get(sessionId)!.push(snap);
    } catch {
      // skip unloadable nodes
    }
  }

  for (const events of sessions.values()) {
    events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  return { sessions, total: allEventIds.length, skipped };
}

/**
 * Execute one skill across all sessions with unprocessed events.
 */
export async function runOneSkill(opts: RunOneSkillOptions): Promise<RunOneSkillResult> {
  const { db, projectName, skillName, prompt, processedEventIds, onBatchProcessed, batchStep = 10, allowInsert, auth, signal } = opts;
  const result: RunOneSkillResult = { batches: 0, sessions: 0, events: 0, errors: [] };

  if (!auth) {
    result.errors.push({ error: `Skill "${skillName}" requires parameters.auth (provider + model + apiKey)` });
    return result;
  }

  const { sessions, total, skipped } = loadNewEventsGroupedBySession(db, processedEventIds);
  if (sessions.size === 0) {
    console.log(`[indexAgent:${skillName}] ${total} events total, ${skipped} already processed — nothing to do`);
    return result;
  }

  console.log(`[indexAgent:${skillName}] ${sessions.size} sessions with new events (${total} total, ${skipped} processed)`);

  for (const [sessionId, sessionEvents] of sessions) {
    if (signal?.aborted) {
      console.log(`[indexAgent:${skillName}] aborted before session ${sessionId}`);
      break;
    }
    const batches = buildBatches(sessionEvents, batchStep);
    console.log(`  Session ${sessionId}: ${sessionEvents.length} events → ${batches.length} batches`);

    try {
      await runSkillInteractive({
        db,
        skillName,
        skillPrompt: prompt,
        eventBatches: batches.map(b => b.payload),
        sourceId: sessionId,
        projectName,
        auth,
        allowInsert,
        signal,
        onBatchComplete: async (batchIndex: number) => {
          const batchEventIds = batches[batchIndex]!.eventIds;
          if (onBatchProcessed) await onBatchProcessed(batchEventIds);
        },
      });
      result.batches += batches.length;
      result.events += sessionEvents.length;
      result.sessions += 1;
    } catch (err) {
      // Aborted runs aren't errors — the scheduler initiated the cancel.
      if (signal?.aborted) {
        console.log(`[indexAgent:${skillName}] session ${sessionId} aborted: ${(err as Error).message}`);
        break;
      }
      result.errors.push({ error: `[${skillName}/${sessionId}] ${(err as Error).message}` });
    }
  }

  return result;
}
