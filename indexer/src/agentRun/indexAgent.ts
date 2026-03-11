import type { Db } from '@retrival-mcp/core';
import { formatDeepNode } from '@retrival-mcp/core';
import { loadAuth, authToQueryOptions } from './auth.js';
import { runSkillInteractive } from './runSkill.js';

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
   * Number of events per interactive turn (batch).
   * Default: 10.
   */
  batchStep?: number;
}

export interface IndexAgentResult {
  batches: number;
  errors: Array<{ error: string }>;
}

/** Named types that represent indexable log events. */
const EVENT_TYPES = ['UserInput', 'FileOperation', 'ShellExecution', 'AgentQuestion'];

/**
 * Main prompt for the single indexing session.
 *
 * Covers local decisions + LSP enrichment as primary tasks.
 * The agent may call list_skills / get_skill to load additional skill prompts.
 */
const MAIN_PROMPT = `You are a software project knowledge graph indexer.
You will receive batches of agent session events (user inputs, file operations, shell commands).

## Primary tasks

### Task 1 — Index local decisions and local changes

For each batch, identify implementation choices and concrete local changes.

LocalDecision — a deliberate choice within a function or module:
  title: short imperative phrase (e.g. "Use early return to reduce nesting")
  rationale: why this was the right approach
  symbols: list of { "$id": "<uuid>" } for LSP symbol nodes this concerns
           — find IDs via exact search on function/class name before inserting
           — omit or use [] if no matching symbols are indexed yet

Choice — when one option was explicitly rejected in favour of another:
  chosen: what was selected (e.g. "better-sqlite3")
  option: what was rejected (e.g. "sql.js")
  reason: why the option was not chosen
  symbols: list of { "$id": "<uuid>" } for related LSP nodes

LocalChangeEvent — a concrete local change: a shift in understanding, assumption, interface
contract, or implementation scoped to a file, function, or this session's log.
Extract when you see something being corrected, reversed, redefined, or updated at a local level.
  name: short label (e.g. "parseQuery now returns null on empty input instead of throwing")
  description: what changed, why, and what the new behaviour or contract is
  scope: one of "file" | "function" | "interface" | "assumption" | "implementation"
  symbols: list of { "$id": "<uuid>" } for LSP nodes whose behaviour or contract changed

Examples:
  { "$type": "LocalDecision", "title": "Use Map instead of object for accumulator", "rationale": "Map preserves insertion order and has O(1) keyed lookups", "symbols": [{ "$id": "uuid-of-buildIndex" }] }
  { "$type": "Choice", "chosen": "early return", "option": "nested else", "reason": "Reduces nesting and keeps the happy path at the top level", "symbols": [] }
  { "$type": "LocalChangeEvent", "name": "buildEntryNode now validates $id node existence", "description": "Previously $id references were passed through without checking; now the node must exist in the DB or an error is thrown", "scope": "function", "symbols": [{ "$id": "uuid-of-buildEntryNode" }] }
  { "$type": "LocalChangeEvent", "name": "relatedSymbols field changed from List<Symbol> to List<AnyLspSymbol>", "description": "Items now reference actual Lsp* nodes instead of storing plain string identifiers; populated by LSP indexer rather than enricher", "scope": "interface", "symbols": [] }

### Task 2 — Enrich LSP symbols with comments

When file operations in the batch touch source files, use exact or raw_query to find the
Lsp* symbols for those files. If a symbol has no comment field, add a brief one explaining
what it does (inferred from the log context).

Use upsert_entries with the existing node id to patch in the comment:
  { "$type": "LspFunction", "id": "<uuid>", "comment": "Builds the flat symbol to event index used during LSP enrichment" }

### Task 3 — Load additional skills as needed

If you see patterns that match other indexing tasks (contracts, API surface, architectural
decisions, concurrency), use:
  list_skills — to see all available skill names and descriptions
  get_skill   — to load a specific skill's full prompt and apply it to the current batch

## Rules
- Only extract entries you are confident about from the event data.
- Do not explain your work. Call tools and continue.
- If nothing to extract from a batch, say "nothing to extract" and stop.
- More events will follow in subsequent messages.
`;

/**
 * Run a single interactive agent session over all indexed log events.
 *
 * Uses one multi-turn qwen session with the main prompt. The agent can
 * load additional skill prompts via list_skills / get_skill.
 */
export async function indexAgent(opts: IndexAgentOptions): Promise<IndexAgentResult> {
  const { db, dbPath, batchStep = 10, pathToQwenExecutable } = opts;
  const result: IndexAgentResult = { batches: 0, errors: [] };

  const auth = loadAuth();
  const qOpts = authToQueryOptions(auth);

  // Load all indexed event nodes
  const eventIds = db.queryByNamedType(EVENT_TYPES);
  if (eventIds.length === 0) return result;

  // Snapshot events at depth 3
  const events: Array<{ id: string; summary: unknown }> = [];
  for (const id of eventIds) {
    try {
      const node = db.loadNodeDeep(id, 3);
      events.push({ id, summary: formatDeepNode(node) });
    } catch {
      // skip unloadable nodes
    }
  }

  // Split into batches
  const eventBatches: string[] = [];
  for (let i = 0; i < events.length; i += batchStep) {
    eventBatches.push(JSON.stringify(events.slice(i, i + batchStep), null, 2));
  }

  console.log(`  Main session: ${eventBatches.length} batches × ${batchStep} events`);

  try {
    await runSkillInteractive({
      skillName: 'MainIndexing',
      skillPrompt: MAIN_PROMPT,
      eventBatches,
      dbPath,
      queryOptions: qOpts,
      pathToQwenExecutable,
    });
    result.batches = eventBatches.length;
  } catch (err) {
    result.errors.push({ error: (err as Error).message });
  }

  return result;
}
