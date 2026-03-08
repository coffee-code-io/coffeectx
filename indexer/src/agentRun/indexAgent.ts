import type { Db } from '@retrival-mcp/core';
import { formatDeepNode } from '@retrival-mcp/core';
import { loadAuth, authToQueryOptions } from './auth.js';
import { runSkill, formatTypeSchema } from './runSkill.js';

export interface IndexAgentOptions {
  db: Db;
  /** Absolute path to the project SQLite database (forwarded to MCP subprocess). */
  dbPath: string;
  /** If set, only run the skill with this name. */
  skillFilter?: string;
  /**
   * Explicit path to the qwen CLI executable.
   * Overrides auth.yaml qwenPath and the auto-resolved packaged default.
   */
  pathToQwenExecutable?: string;
  /**
   * Number of events to advance between batches.
   * The agent is invoked once per batchStep events.
   * Default: 10.
   */
  batchStep?: number;
  /**
   * Number of events in the context window fed to qwen per invocation.
   * The window is the last suffixLen events up to the current position.
   * Default: 100.
   */
  suffixLen?: number;
}

export interface IndexAgentResult {
  skills: number;
  batches: number;
  errors: Array<{ skill: string; batch: number; error: string }>;
}

/** Named types that represent indexable log events. */
const EVENT_TYPES = ['UserInput', 'FileOperation', 'ShellExecution', 'AgentQuestion'];

/**
 * Run the agent indexer for all (or one filtered) skill.
 *
 * For each skill, walks the indexed log events in batchStep increments.
 * At each step, the agent sees the last suffixLen events and is instructed
 * to extract entities defined by the skill and insert them into the graph.
 */
export async function indexAgent(opts: IndexAgentOptions): Promise<IndexAgentResult> {
  const { db, dbPath, skillFilter, batchStep = 10, suffixLen = 100, pathToQwenExecutable } = opts;
  const result: IndexAgentResult = { skills: 0, batches: 0, errors: [] };

  // Load auth from ~/.coffeecode/auth.yaml
  const auth = loadAuth();
  const qOpts = authToQueryOptions(auth);

  // Load skills (with prompts)
  const skillHeaders = db.listSkills();
  const skills = (skillFilter
    ? skillHeaders.filter(s => s.name === skillFilter)
    : skillHeaders
  ).map(s => db.getSkill(s.name)).filter(Boolean) as NonNullable<ReturnType<typeof db.getSkill>>[];

  if (skills.length === 0) {
    return result;
  }

  // Load all indexed event nodes
  const eventIds = db.queryByNamedType(EVENT_TYPES);
  if (eventIds.length === 0) {
    return result;
  }

  // Snapshot events at depth 3 for context (enough to see all top-level fields)
  const events: Array<{ id: string; summary: unknown }> = [];
  for (const id of eventIds) {
    try {
      const node = db.loadNodeDeep(id, 3);
      events.push({ id, summary: formatDeepNode(node) });
    } catch {
      // skip unloadable nodes
    }
  }

  for (const skill of skills) {
    result.skills++;
    let batchIndex = 0;

    // Helper to load and format type schemas for this skill
    const getTypeSchema = (typeName: string): string | null => {
      try {
        const namedType = db.loadNamedType(typeName);
        if (!namedType) return null;
        const typeObj = db.loadType(namedType.typeId);
        return formatTypeSchema(typeObj);
      } catch {
        return null;
      }
    };

    for (let i = 0; i < events.length; i += batchStep) {
      batchIndex++;
      const suffixEnd = Math.min(i + batchStep, events.length);
      const suffixStart = Math.max(0, suffixEnd - suffixLen);
      const window = events.slice(suffixStart, suffixEnd);

      const eventsText = JSON.stringify(window, null, 2);

      try {
        console.log(`    Skill "${skill.name}" batch ${batchIndex}/${Math.ceil(events.length / batchStep)} (events ${suffixStart}–${suffixEnd - 1})`);
        await runSkill({
          skillName: skill.name,
          skillPrompt: skill.prompt,
          eventsText,
          dbPath,
          queryOptions: qOpts,
          pathToQwenExecutable,
          skillTypeNames: skill.types,
          getTypeSchema,
        });
        result.batches++;
      } catch (err) {
        result.errors.push({
          skill: skill.name,
          batch: batchIndex,
          error: (err as Error).message,
        });
      }
    }
  }

  return result;
}
