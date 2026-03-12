import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import type { Db } from '@coffeectx/core';
import { formatDeepNode } from '@coffeectx/core';
import { loadAuth, authToQueryOptions } from './auth.js';
import { runSkillInteractive, EPHEMERAL_CONTEXT_BEGIN, EPHEMERAL_CONTEXT_END } from './runSkill.js';

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

/** Load all skill definitions from indexer/skills/ (each subdirectory has skill.yaml + SKILL.md). */
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

/**
 * Run interactive agent sessions over all indexed log events, one per skill.
 *
 * Each skill runs as a separate qwen session over the same event batches,
 * so tasks stay focused and the model doesn't get lost across concerns.
 *
 * AgentThought entries are bundled with their batch but don't count toward
 * batch size; they are wrapped in ephemeral markers and pruned after each
 * batch result (curated history).
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

  // Load all indexed event nodes
  const eventIds = db.queryByNamedType(EVENT_TYPES);
  if (eventIds.length === 0) return result;

  // Snapshot events at depth 1, tagged with whether they are thoughts
  interface EventSnapshot { id: string; isThought: boolean; summary: unknown }
  const events: EventSnapshot[] = [];
  for (const id of eventIds) {
    try {
      const typeName = db.getNodeTypeName(id);
      const node = db.loadNodeDeep(id, 1);
      events.push({ id, isThought: typeName === THOUGHT_ONLY_TYPE, summary: formatDeepNode(node) });
    } catch {
      // skip unloadable nodes
    }
  }

  // Split into batches: batchStep counts only non-thought events.
  // Thoughts are bundled with the batch they preceded (same batch window).
  // They are wrapped in ephemeral markers so the indexing agent can use them
  // as context for the current batch; after each result the markers are pruned
  // from conversation history (curated history).
  const eventBatches: string[] = [];
  let currentBatch: EventSnapshot[] = [];
  let nonThoughtCount = 0;

  function flushBatch(batch: EventSnapshot[]): string {
    const thoughts = batch.filter(e => e.isThought).map(e => e.summary);
    const regular = batch.filter(e => !e.isThought).map(e => e.summary);
    let text = JSON.stringify(regular, null, 2);
    if (thoughts.length > 0) {
      text = `${EPHEMERAL_CONTEXT_BEGIN}\n${JSON.stringify(thoughts, null, 2)}\n${EPHEMERAL_CONTEXT_END}\n\n${text}`;
    }
    return text;
  }

  for (const event of events) {
    currentBatch.push(event);
    if (!event.isThought) {
      nonThoughtCount++;
      if (nonThoughtCount >= batchStep) {
        eventBatches.push(flushBatch(currentBatch));
        currentBatch = [];
        nonThoughtCount = 0;
      }
    }
  }
  if (currentBatch.length > 0) {
    eventBatches.push(flushBatch(currentBatch));
  }

  console.log(`  ${eventBatches.length} batches × up to ${batchStep} events (+ thoughts), ${skills.length} skills`);

  for (const skill of skills) {
    console.log(`  Running skill "${skill.name}"...`);
    try {
      await runSkillInteractive({
        skillName: skill.name,
        skillPrompt: skill.prompt,
        eventBatches,
        dbPath,
        queryOptions: qOpts,
        pathToQwenExecutable,
      });
      result.batches += eventBatches.length;
    } catch (err) {
      result.errors.push({ error: `[${skill.name}] ${(err as Error).message}` });
    }
  }

  return result;
}
