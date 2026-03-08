import { query } from '@qwen-code/sdk';
import type { QueryOptions } from '@qwen-code/sdk';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the MCP server entry point (mcp/dist/index.js). */
const MCP_SERVER_PATH = resolve(__dirname, '../../../mcp/dist/index.js');

/**
 * Resolve the packaged qwen CLI from the @qwen-code/sdk package.
 * Returns undefined if not found — the SDK will then auto-discover it.
 */
function resolveQwenCliPath(): string | undefined {
  try {
    const req = createRequire(import.meta.url);
    const pkgJson = req.resolve('@qwen-code/sdk/package.json');
    const cliPath = join(dirname(pkgJson), 'dist', 'cli', 'cli.js');
    if (existsSync(cliPath)) return cliPath;
  } catch {
    // fall through — SDK auto-discovery will handle it
  }
  return undefined;
}

const DEFAULT_QWEN_CLI = resolveQwenCliPath();

export interface RunSkillOptions {
  skillName: string;
  skillPrompt: string;
  /** Serialized representation of the event window to analyze. */
  eventsText: string;
  /** Absolute path to the project SQLite database. */
  dbPath: string;
  /** Partial QueryOptions derived from auth.yaml (authType, model, env, pathToQwenExecutable). */
  queryOptions: Partial<QueryOptions>;
  /**
   * Override for the qwen CLI path.
   * Priority: this field > queryOptions.pathToQwenExecutable > packaged CLI > SDK auto-discovery.
   */
  pathToQwenExecutable?: string;
}

/**
 * Run a single qwen session for one skill batch.
 *
 * Qwen is launched in yolo mode but with file-editing tools excluded —
 * it can only interact with the knowledge graph via MCP insert/annotate tools.
 * The function resolves when the qwen process has finished.
 */
export async function runSkill(opts: RunSkillOptions): Promise<void> {
  const { skillName, skillPrompt, eventsText, dbPath, queryOptions, pathToQwenExecutable } = opts;

  console.log(`[runSkill] Starting qwen session for skill "${skillName}"`);

  const mcpEnv: Record<string, string> = {
    RETRIVAL_DB_PATH: dbPath,
    RETRIVAL_INSERT: '1',
    ...(queryOptions.env ?? {}),
  };

  // Priority: explicit arg > from auth.yaml (already in queryOptions) > packaged CLI
  const qwenPath =
    pathToQwenExecutable ??
    queryOptions.pathToQwenExecutable ??
    DEFAULT_QWEN_CLI;

  console.log(`[runSkill] Using qwen CLI: ${qwenPath ?? '(SDK auto-discovery)'}`);

  const prompt = `You are populating a software project knowledge graph.

Skill: ${skillName}

Instructions:
${skillPrompt}

Below is a window of recent agent log events from the project (JSON).
Analyze them and extract the entities described by the skill instructions.
Insert them into the knowledge graph via the MCP tools (insert_entries or annotate_node).
Do not explain your work — just insert.

---
${eventsText}
---`;

  try {
    const q = query({
      prompt,
      options: {
        ...queryOptions,
        env: mcpEnv,
        permissionMode: 'yolo',
        // Allow read tools + MCP; forbid any file-system writes.
        excludeTools: ['Write', 'Edit', 'Bash', 'NotebookEdit', 'Agent'],
        ...(qwenPath ? { pathToQwenExecutable: qwenPath } : {}),
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

    // Drain the stream — qwen inserts data via MCP tool calls
    let messageCount = 0;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _msg of q) {
      messageCount++;
      if (messageCount % 10 === 0) {
        console.log(`[runSkill] Processed ${messageCount} messages from qwen for skill "${skillName}"`);
      }
    }

    console.log(`[runSkill] Completed skill "${skillName}" with ${messageCount} total messages`);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;
    console.error(`[runSkill] Error processing skill "${skillName}": ${errorMessage}`);
    if (errorStack) {
      console.error(`[runSkill] Stack trace:\n${errorStack}`);
    }
    throw error;
  }
}
