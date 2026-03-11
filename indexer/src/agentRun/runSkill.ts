import { query, isSDKResultMessage } from '@qwen-code/sdk';
import type { QueryOptions, SDKUserMessage } from '@qwen-code/sdk';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the MCP server entry point (mcp/dist/index.js). */
const MCP_SERVER_PATH = resolve(__dirname, '../../../mcp/dist/index.js');

/** Retrival-mcp project root — used as cwd so the qwen skill manager finds .qwen/skills/. */
const PROJECT_ROOT = resolve(__dirname, '../../..');

/** Absolute path to the indexer system prompt loaded via QWEN_SYSTEM_MD. */
const SYSTEM_PROMPT_PATH = join(__dirname, '../../prompts/system.md');

/**
 * Sentinel markers for ephemeral thought context.
 *
 * Content between these markers is injected into the current batch so the
 * indexing agent can use agent-thought reasoning as context. After each batch
 * result, `pruneEphemeralContext()` removes these blocks from the conversation
 * history so they don't accumulate in subsequent batches (curated history).
 */
export const EPHEMERAL_CONTEXT_BEGIN = '[EPHEMERAL_CONTEXT_BEGIN]';
export const EPHEMERAL_CONTEXT_END = '[EPHEMERAL_CONTEXT_END]';

/**
 * Resolve the packaged qwen CLI from the @qwen-code/sdk package.
 * Returns undefined if not found — the SDK will then auto-discover it.
 */
function resolveQwenCliPath(): string | undefined {
  try {
    const req = createRequire(import.meta.url);
    const pkgJson = req.resolve('@qwen-code/sdk/package.json');
    const pkgDir = dirname(pkgJson);
    const monorepoCliPath = join(pkgDir, '..', '..', 'dist', 'cli.js');
    if (existsSync(monorepoCliPath)) return monorepoCliPath;
  } catch {
    // fall through — SDK auto-discovery will handle it
  }
  return undefined;
}

const DEFAULT_QWEN_CLI = resolveQwenCliPath();

export interface RunSkillInteractiveOptions {
  skillName: string;
  skillPrompt: string;
  /** All events to process, pre-serialized per batch. */
  eventBatches: string[];
  /** Absolute path to the project SQLite database. */
  dbPath: string;
  /** Partial QueryOptions derived from auth.yaml. */
  queryOptions: Partial<QueryOptions>;
  /** Override for the qwen CLI path. */
  pathToQwenExecutable?: string;
}

function buildIntroPrompt(skillPrompt: string, firstBatch: string): string {
  return `${skillPrompt}

---
${firstBatch}
---`;
}

function buildBatchPrompt(batchIndex: number, totalBatches: number, eventsText: string): string {
  return `Batch ${batchIndex + 1} of ${totalBatches}. Apply the same skill as before.

---
${eventsText}
---`;
}

/**
 * Run a single interactive multi-turn qwen session for one skill.
 *
 * Each batch of events is sent as a separate user turn. The session stays
 * open across batches so the model retains continuity (e.g. can cross-reference
 * decisions from earlier batches).
 *
 * **Curated history**: After each batch result, ephemeral thought context
 * (wrapped in EPHEMERAL_CONTEXT_BEGIN/END markers) is pruned from the
 * conversation history so agent thoughts don't accumulate across batches.
 * Regular events remain in history for continuity.
 */
export async function runSkillInteractive(opts: RunSkillInteractiveOptions): Promise<void> {
  const { skillName, skillPrompt, eventBatches, dbPath, queryOptions, pathToQwenExecutable } = opts;

  if (eventBatches.length === 0) return;

  console.log(`[runSkill] Starting interactive session for skill "${skillName}" (${eventBatches.length} batches)`);

  const mcpEnv: Record<string, string> = {
    RETRIVAL_DB_PATH: dbPath,
    RETRIVAL_INSERT: '1',
    QWEN_SYSTEM_MD: SYSTEM_PROMPT_PATH,
    ...(queryOptions.env ?? {}),
  };

  const qwenPath = pathToQwenExecutable ?? queryOptions.pathToQwenExecutable ?? DEFAULT_QWEN_CLI;
  console.log(`[runSkill] Using qwen CLI: ${qwenPath ?? '(SDK auto-discovery)'}`);

  // Turn completion signalling: generator waits for the drain loop to confirm
  // each turn is done before yielding the next batch.
  let turnComplete: (() => void) | undefined;

  async function* generateMessages(): AsyncGenerator<SDKUserMessage> {
    const sessionId = crypto.randomUUID();
    let waitPromise: Promise<void> | undefined;

    for (let i = 0; i < eventBatches.length; i++) {
      // Wait for the previous turn's result before sending the next batch
      if (i > 0 && waitPromise) {
        await waitPromise;
      }

      // Set up the signal for THIS turn's completion (consumed after next yield)
      if (i < eventBatches.length - 1) {
        waitPromise = new Promise<void>(r => { turnComplete = r; });
      }

      const content = i === 0
        ? buildIntroPrompt(skillPrompt, eventBatches[0]!)
        : buildBatchPrompt(i, eventBatches.length, eventBatches[i]!);

      yield {
        type: 'user',
        session_id: sessionId,
        message: { role: 'user', content },
        parent_tool_use_id: null,
      } satisfies SDKUserMessage;
    }
  }

  try {
    const q = query({
      prompt: generateMessages(),
      options: {
        ...queryOptions,
        cwd: PROJECT_ROOT,
        env: mcpEnv,
        permissionMode: 'yolo',
        excludeTools: ['Write', 'Edit', 'Bash', 'NotebookEdit', 'Agent'],
        ...(qwenPath ? { pathToQwenExecutable: qwenPath } : {}),
        stderr: (msg: string) => process.stderr.write(`[runSkill:qwen-stderr] ${msg}`),
        mcpServers: {
          retrival: {
            command: 'node',
            args: [MCP_SERVER_PATH],
            env: mcpEnv,
            trust: true,
          },
        },
      },
    });

    let messageCount = 0;
    let batchCount = 0;

    for await (const msg of q) {
      messageCount++;
      if (isSDKResultMessage(msg)) {
        batchCount++;
        console.log(`[runSkill] Batch ${batchCount}/${eventBatches.length} done (${messageCount} total messages)`);

        // Prune ephemeral thought context from history before the next batch.
        // This implements curated history: thoughts enrich the current batch
        // but don't accumulate in the conversation window for subsequent batches.
        try {
          await q.pruneEphemeralContext();
        } catch (pruneErr) {
          // Non-fatal — log and continue
          console.warn(`[runSkill] pruneEphemeralContext failed: ${(pruneErr as Error).message}`);
        }

        // Unblock the generator so it can yield the next batch
        turnComplete?.();
        turnComplete = undefined;
      }
    }

    console.log(`[runSkill] Completed skill "${skillName}" — ${batchCount} batches, ${messageCount} total messages`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    console.error(`[runSkill] Error in skill "${skillName}": ${errorMessage}`);
    if (errorStack) console.error(`[runSkill] Stack:\n${errorStack}`);
    throw error;
  }
}
