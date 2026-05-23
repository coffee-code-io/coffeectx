import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import type { Db, DeepNode, AuthSettings } from '@coffeectx/core';
import { formatDeepNode } from '@coffeectx/core';
import { runSkillInteractive, type BatchPayload } from './runSkill.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Named types that represent indexable agent-log events. Each row is a
 * candidate batch item for skill jobs. AgentSummary is one-per-session and
 * carries the ai-title — included so skills can attach the title to the
 * session context.
 */
const EVENT_TYPES = ['UserInput', 'FileOperation', 'ShellExecution', 'AgentQuestion', 'AgentMessage', 'AgentSummary'];

interface SkillDef {
  name: string;
  description: string;
  prompt: string;
}

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

/** Resolve the absolute path of the bundled skills directory. */
export function skillsDir(): string {
  return join(__dirname, '../../skills');
}

/** Load a single skill definition by directory name; returns null if missing. */
export function loadSkillDef(dirName: string): SkillDef | null {
  const dir = join(skillsDir(), dirName);
  try {
    const meta = parseYaml(readFileSync(join(dir, 'skill.yaml'), 'utf-8')) as { name: string; description: string };
    const prompt = readFileSync(join(dir, 'SKILL.md'), 'utf-8');
    return { name: meta.name, description: meta.description, prompt };
  } catch (err) {
    console.warn(`[indexAgent] Failed to load skill from ${dir}:`, (err as Error).message);
    return null;
  }
}

/** Return the directory names of all available skills. */
export function listAvailableSkills(): string[] {
  try { return readdirSync(skillsDir()); }
  catch { return []; }
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
  /** Directory name of the skill under indexer/skills/. */
  skillDirName: string;
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
  const { db, projectName, skillDirName, processedEventIds, onBatchProcessed, batchStep = 10, allowInsert, auth, signal } = opts;
  const result: RunOneSkillResult = { batches: 0, sessions: 0, events: 0, errors: [] };

  const skill = loadSkillDef(skillDirName);
  if (!skill) {
    result.errors.push({ error: `Skill "${skillDirName}" not found in indexer/skills/` });
    return result;
  }
  if (!auth) {
    result.errors.push({ error: `Skill "${skillDirName}" requires parameters.auth (provider + model + apiKey)` });
    return result;
  }

  const { sessions, total, skipped } = loadNewEventsGroupedBySession(db, processedEventIds);
  if (sessions.size === 0) {
    console.log(`[indexAgent:${skillDirName}] ${total} events total, ${skipped} already processed — nothing to do`);
    return result;
  }

  console.log(`[indexAgent:${skillDirName}] ${sessions.size} sessions with new events (${total} total, ${skipped} processed)`);

  for (const [sessionId, sessionEvents] of sessions) {
    if (signal?.aborted) {
      console.log(`[indexAgent:${skillDirName}] aborted before session ${sessionId}`);
      break;
    }
    const batches = buildBatches(sessionEvents, batchStep);
    console.log(`  Session ${sessionId}: ${sessionEvents.length} events → ${batches.length} batches`);

    try {
      await runSkillInteractive({
        db,
        skillName: skill.name,
        skillPrompt: skill.prompt,
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
        console.log(`[indexAgent:${skillDirName}] session ${sessionId} aborted: ${(err as Error).message}`);
        break;
      }
      result.errors.push({ error: `[${skillDirName}/${sessionId}] ${(err as Error).message}` });
    }
  }

  return result;
}
