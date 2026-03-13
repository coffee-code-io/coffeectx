import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import type { Db, DeepNode } from '@coffeectx/core';
import { formatDeepNode } from '@coffeectx/core';
import { loadAuth, authToQueryOptions } from './auth.js';
import { runSkillInteractive, PROJECT_ROOT, EPHEMERAL_CONTEXT_BEGIN, EPHEMERAL_CONTEXT_END } from './runSkill.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface IndexAgentOptions {
  db: Db;
  /** Absolute path to the project SQLite database (forwarded to MCP subprocess). */
  dbPath: string;
  /**
   * Explicit path to the qwen CLI executable.
   * Overrides auth.yaml qwenPath and the auto-resolved packaged default.
   */
  pathToQwenExecutable?: string;
  /**
   * Number of non-thought events per batch (AgentThought entries don't count).
   * Default: 10.
   */
  batchStep?: number;
}

export interface IndexAgentResult {
  batches: number;
  errors: Array<{ error: string }>;
}

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

/** Load all skill definitions from indexer/skills/. */
function loadSkillDefs(): SkillDef[] {
  const skillsDir = join(__dirname, '../../skills');
  let names: string[];
  try {
    names = readdirSync(skillsDir);
  } catch {
    console.warn('[indexAgent] No skills directory found at', skillsDir);
    return [];
  }

  const defs: SkillDef[] = [];
  for (const name of names) {
    const dir = join(skillsDir, name);
    try {
      const meta = parseYaml(readFileSync(join(dir, 'skill.yaml'), 'utf-8')) as { name: string; description: string };
      const prompt = readFileSync(join(dir, 'SKILL.md'), 'utf-8');
      defs.push({ name: meta.name, description: meta.description, prompt });
    } catch (err) {
      console.warn(`[indexAgent] Failed to load skill from ${dir}:`, (err as Error).message);
    }
  }
  return defs;
}

/** Split a sorted event list into batches of batchStep non-thought events. */
function buildBatches(events: EventSnapshot[], batchStep: number): string[] {
  const batches: string[] = [];
  let currentBatch: EventSnapshot[] = [];
  let nonThoughtCount = 0;

  for (const event of events) {
    currentBatch.push(event);
    if (!event.isThought) {
      nonThoughtCount++;
      if (nonThoughtCount >= batchStep) {
        batches.push(flushBatch(currentBatch));
        currentBatch = [];
        nonThoughtCount = 0;
      }
    }
  }
  if (currentBatch.length > 0) {
    batches.push(flushBatch(currentBatch));
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

/**
 * Run interactive agent sessions over unindexed log events, grouped by session.
 *
 * Each event type carries an optional `agentIndexed` field. Events without it
 * are "new" and will be processed; events that already have it are skipped.
 * This lets sessions grow over time: re-running only processes new events.
 *
 * Each (logSession, skill) pair gets a **deterministic** Qwen session ID so the
 * prior conversation can be continued without storing anything in the DB:
 * - If the Qwen session file already exists on disk → `--resume <id>` (continue)
 * - Otherwise → `--session-id <id>` (start new session with that stable ID)
 *
 * After all skills complete for a session's new events, every processed event
 * is patched with `agentIndexed = <ISO timestamp>` so future runs skip it.
 *
 * Events are grouped by sessionId and sorted by timestamp so the model sees
 * each session's events in chronological order.
 */
export async function indexAgent(opts: IndexAgentOptions): Promise<IndexAgentResult> {
  const { db, dbPath, batchStep = 10, pathToQwenExecutable } = opts;
  const result: IndexAgentResult = { batches: 0, errors: [] };

  const auth = loadAuth();
  const qOpts = authToQueryOptions(auth);
  const skills = loadSkillDefs();

  if (skills.length === 0) {
    console.warn('[indexAgent] No skills found — nothing to index');
    return result;
  }

  // ── Load all events, split into indexed / new ────────────────────────────────
  const allEventIds = db.queryByNamedType(EVENT_TYPES);
  if (allEventIds.length === 0) return result;

  const newEvents: EventSnapshot[] = [];
  let skippedCount = 0;

  for (const id of allEventIds) {
    try {
      if (db.getMapFieldId(id, 'agentIndexed') !== null) {
        skippedCount++;
        continue;
      }

      const typeName = db.getNodeTypeName(id) ?? 'unknown';
      const node = db.loadNodeDeep(id, 1);
      if (node.kind !== 'map') continue;

      const sessionId = getSymbolValue(node.entries['sessionId']);
      if (!sessionId) continue;

      const timestamp = getSymbolValue(node.entries['timestamp']) ?? '';
      const isThought = typeName === THOUGHT_ONLY_TYPE;
      newEvents.push({ id, isThought, timestamp, sessionId, typeName, summary: formatDeepNode(node) });
    } catch {
      // skip unloadable nodes
    }
  }

  console.log(`[indexAgent] ${allEventIds.length} events total: ${newEvents.length} new, ${skippedCount} already indexed`);

  if (newEvents.length === 0) {
    console.log('[indexAgent] Nothing new to index');
    return result;
  }

  // ── Group by sessionId, sort by timestamp ───────────────────────────────────
  const eventsBySession = new Map<string, EventSnapshot[]>();
  for (const event of newEvents) {
    if (!eventsBySession.has(event.sessionId)) eventsBySession.set(event.sessionId, []);
    eventsBySession.get(event.sessionId)!.push(event);
  }
  for (const events of eventsBySession.values()) {
    events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  console.log(`[indexAgent] ${eventsBySession.size} sessions with new events`);

  // ── Process each session ─────────────────────────────────────────────────────
  for (const [sessionId, sessionEvents] of eventsBySession) {
    const eventBatches = buildBatches(sessionEvents, batchStep);
    console.log(`[indexAgent] Session ${sessionId}: ${sessionEvents.length} new events → ${eventBatches.length} batches, ${skills.length} skills`);

    let allOk = true;
    for (const skill of skills) {
      // Derive a stable session ID so we can resume the same Qwen conversation.
      const qwenId = deriveQwenSessionId(sessionId, skill.name);
      const sessionFileExists = qwenSessionFileExists(qwenId);

      console.log(`  Running skill "${skill.name}" (qwen session ${qwenId}${sessionFileExists ? ' [resuming]' : ' [new]'})...`);

      try {
        await runSkillInteractive({
          skillName: skill.name,
          skillPrompt: skill.prompt,
          eventBatches,
          dbPath,
          queryOptions: qOpts,
          pathToQwenExecutable,
          ...(sessionFileExists
            ? { resumeSessionId: qwenId }
            : { newSessionId: qwenId }),
        });
        result.batches += eventBatches.length;
      } catch (err) {
        allOk = false;
        result.errors.push({ error: `[${skill.name}/${sessionId}] ${(err as Error).message}` });
      }
    }

    // Mark all processed events as indexed
    if (allOk) {
      const now = new Date().toISOString();
      const patches = sessionEvents.map(e => ({
        id: e.id,
        type: e.typeName,
        data: { agentIndexed: now },
      }));

      try {
        const patchResult = await db.insertEntries(patches);
        const failed = patchResult.errors.length;
        if (failed > 0) {
          console.warn(`[indexAgent] ${failed} events could not be marked (sync-types may be needed): ${patchResult.errors[0]?.message}`);
        } else {
          console.log(`[indexAgent] Marked ${patches.length} events as indexed`);
        }
      } catch (err) {
        console.warn(`[indexAgent] Failed to mark events for session ${sessionId}: ${(err as Error).message}`);
      }
    }
  }

  return result;
}
