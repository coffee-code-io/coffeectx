import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import type { Db, DeepNode, AuthSettings } from '@coffeectx/core';
import { formatDeepNode } from '@coffeectx/core';
import { authToQueryOptions } from './auth.js';
import { runSkillInteractive, PROJECT_ROOT, EPHEMERAL_CONTEXT_BEGIN, EPHEMERAL_CONTEXT_END } from './runSkill.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Named types that represent indexable log events. */
const EVENT_TYPES = ['UserInput', 'FileOperation', 'ShellExecution', 'AgentQuestion', 'AgentThought'];

/** AgentThought entries enrich context but don't count toward batch size. */
const THOUGHT_ONLY_TYPE = 'AgentThought';

interface SkillDef {
  name: string;
  description: string;
  prompt: string;
}

interface EventSnapshot {
  id: string;
  isThought: boolean;
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

/**
 * Derive a deterministic Qwen session ID from a log session ID and skill name.
 * Formatted as a UUID so it's compatible with Qwen's session file naming.
 * Using a fixed ID means we can always find the session file without storing it.
 */
function deriveQwenSessionId(logSessionId: string, skillName: string): string {
  const hash = createHash('sha256').update(`${logSessionId}:${skillName}`).digest('hex');
  // Force UUID v4 format required by Qwen's UUID_REGEX:
  //   xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx
  //   version nibble = '4' (position 12), variant nibble = '8' (position 16)
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    '4' + hash.slice(13, 16),   // version 4
    '8' + hash.slice(17, 20),   // variant 10xx
    hash.slice(20, 32),
  ].join('-');
}

/**
 * Check whether a Qwen CLI session file exists on disk for the given session ID.
 * Sessions are stored at: ~/.qwen/projects/<sanitized-cwd>/chats/<sessionId>.jsonl
 * The cwd used is PROJECT_ROOT (same value passed as options.cwd to the CLI).
 */
function qwenSessionFileExists(sessionId: string): boolean {
  const sanitized = PROJECT_ROOT.replace(/[^a-zA-Z0-9]/g, '-');
  const chatsDir = join(homedir(), '.qwen', 'projects', sanitized, 'chats');
  return existsSync(join(chatsDir, `${sessionId}.jsonl`));
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
  try {
    return readdirSync(skillsDir());
  } catch {
    return [];
  }
}

/** Split a sorted event list into batches of batchStep non-thought events. */
interface Batch {
  text: string;
  eventIds: string[];
}

function buildBatches(events: EventSnapshot[], batchStep: number): Batch[] {
  const batches: Batch[] = [];
  let currentBatch: EventSnapshot[] = [];
  let nonThoughtCount = 0;

  for (const event of events) {
    currentBatch.push(event);
    if (!event.isThought) {
      nonThoughtCount++;
      if (nonThoughtCount >= batchStep) {
        batches.push({ text: flushBatch(currentBatch), eventIds: currentBatch.map(e => e.id) });
        currentBatch = [];
        nonThoughtCount = 0;
      }
    }
  }
  if (currentBatch.length > 0) {
    batches.push({ text: flushBatch(currentBatch), eventIds: currentBatch.map(e => e.id) });
  }
  return batches;
}

function flushBatch(batch: EventSnapshot[]): string {
  const thoughts = batch.filter(e => e.isThought).map(e => e.summary);
  const regular = batch.filter(e => !e.isThought).map(e => e.summary);
  let text = JSON.stringify(regular, null, 2);
  if (thoughts.length > 0) {
    text = `${EPHEMERAL_CONTEXT_BEGIN}\n${JSON.stringify(thoughts, null, 2)}\n${EPHEMERAL_CONTEXT_END}\n\n${text}`;
  }
  return text;
}

// ── Single-skill executor (used by the per-skill scheduler jobs) ─────────────

export interface RunOneSkillOptions {
  db: Db;
  dbPath: string;
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
  pathToQwenExecutable?: string;
  /** LLM auth for this run (typically from project.jobs[name].parameters.auth). */
  auth?: AuthSettings;
}

export interface RunOneSkillResult {
  batches: number;
  sessions: number;
  events: number;
  errors: Array<{ error: string }>;
}

/**
 * Load all new (unprocessed) log events grouped by sessionId, sorted by timestamp.
 * Returns the snapshots plus a type-name lookup for convenience.
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

      const timestamp = getSymbolValue(node.entries['timestamp']) ?? '';
      const isThought = typeName === THOUGHT_ONLY_TYPE;
      const snap: EventSnapshot = { id, isThought, timestamp, sessionId, typeName, summary: formatDeepNode(node) };
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
 * Execute one skill across all sessions with unprocessed events. The scheduler
 * passes the skill's own processed-event set (from `jobs.state_json`) and a
 * callback that persists newly-processed IDs after each batch.
 */
export async function runOneSkill(opts: RunOneSkillOptions): Promise<RunOneSkillResult> {
  const { db, dbPath, skillDirName, processedEventIds, onBatchProcessed, batchStep = 10, pathToQwenExecutable, auth } = opts;
  const result: RunOneSkillResult = { batches: 0, sessions: 0, events: 0, errors: [] };

  const skill = loadSkillDef(skillDirName);
  if (!skill) {
    result.errors.push({ error: `Skill "${skillDirName}" not found in indexer/skills/` });
    return result;
  }

  const qOpts = authToQueryOptions(auth ?? {});

  const { sessions, total, skipped } = loadNewEventsGroupedBySession(db, processedEventIds);
  if (sessions.size === 0) {
    console.log(`[indexAgent:${skillDirName}] ${total} events total, ${skipped} already processed — nothing to do`);
    return result;
  }

  console.log(`[indexAgent:${skillDirName}] ${sessions.size} sessions with new events (${total} total, ${skipped} processed)`);

  for (const [sessionId, sessionEvents] of sessions) {
    const qwenId = deriveQwenSessionId(sessionId, skill.name);
    const sessionFileExists = qwenSessionFileExists(qwenId);
    const batches = buildBatches(sessionEvents, batchStep);
    const resumeLabel = sessionFileExists ? ' [resuming]' : ' [new]';
    console.log(`  Session ${sessionId} (qwen ${qwenId}${resumeLabel}): ${sessionEvents.length} events → ${batches.length} batches`);

    try {
      await runSkillInteractive({
        skillName: skill.name,
        skillPrompt: skill.prompt,
        eventBatches: batches.map(b => b.text),
        dbPath,
        queryOptions: qOpts,
        pathToQwenExecutable,
        onBatchComplete: async (batchIndex: number) => {
          const batchEventIds = batches[batchIndex]!.eventIds;
          if (onBatchProcessed) await onBatchProcessed(batchEventIds);
        },
        ...(sessionFileExists
          ? { resumeSessionId: qwenId }
          : { newSessionId: qwenId }),
      });
      result.batches += batches.length;
      result.events += sessionEvents.length;
      result.sessions += 1;
    } catch (err) {
      result.errors.push({ error: `[${skillDirName}/${sessionId}] ${(err as Error).message}` });
    }
  }

  return result;
}

