import { query, isSDKResultMessage } from '@qwen-code/sdk';
import type { QueryOptions, SDKUserMessage } from '@qwen-code/sdk';
import type { Type } from '@retrival-mcp/core';
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
  /** Names of entry types this skill is expected to create. */
  skillTypeNames?: string[];
  /** Function to load and format type information. */
  getTypeSchema?: (typeName: string) => string | null;
}

/**
 * Format a Type into a human-readable schema string.
 * Helps qwen understand what fields to populate when creating entries.
 */
export function formatTypeSchema(type: Type, indent = 0): string {
  const spaces = ' '.repeat(indent);
  const nextIndent = indent + 2;
  const nextSpaces = ' '.repeat(nextIndent);

  switch (type.kind) {
    case 'SymbolType':
      return 'string (symbol)';
    case 'MeaningType':
      return 'string (meaningful text to be embedded)';
    case 'MapType': {
      const fields = Object.entries(type.entries)
        .map(([key, fieldType]) => {
          const fieldSchema = formatTypeSchema(fieldType, nextIndent);
          return `${nextSpaces}${key}: ${fieldSchema}`;
        })
        .join('\n');
      return `{\n${fields}\n${spaces}}`;
    }
    case 'ListType': {
      const itemSchema = formatTypeSchema(type.itemType, nextIndent);
      return `[${itemSchema}]`;
    }
    case 'RefType':
      return `${type.name} (named type)`;
    case 'OrType': {
      const left = formatTypeSchema(type.left, nextIndent);
      const right = formatTypeSchema(type.right, nextIndent);
      return `${left} | ${right}`;
    }
    case 'AndType': {
      const left = formatTypeSchema(type.left, nextIndent);
      const right = formatTypeSchema(type.right, nextIndent);
      return `${left} & ${right}`;
    }
    case 'OptionalType': {
      const inner = formatTypeSchema(type.inner, indent);
      return `${inner}?`;
    }
    default:
      return 'unknown';
  }
}

function buildIntroPrompt(
  skillName: string,
  skillPrompt: string,
  firstBatch: string,
  skillTypeNames?: string[],
  getTypeSchema?: (typeName: string) => string | null,
): string {
  let typeSchemaSection = '';
  if (skillTypeNames && skillTypeNames.length > 0 && getTypeSchema) {
    const typeSchemas: string[] = [];
    for (const typeName of skillTypeNames) {
      const schema = getTypeSchema(typeName);
      if (schema) {
        typeSchemas.push(`${typeName} — schema:\n${schema}\n  Example:\n  { "$type": "${typeName}", "fieldName": "value", ... }`);
      }
    }
    if (typeSchemas.length > 0) {
      typeSchemaSection = `

## Entry Types You Must Create

Each entry passed to upsert_entries MUST include "$type" (required) and the relevant fields.

${typeSchemas.join('\n\n')}
`;
    }
  }

  return `You are working with a software project knowledge graph.

Skill: ${skillName}

Instructions:
${skillPrompt}${typeSchemaSection}

## How to call upsert_entries

The tool accepts an "entries" array. Each entry is a flat JSON object where "$type" is required.

Example:
  upsert_entries({
    entries: [
      { "$type": "Decision", "title": "Use SQLite for storage", "rationale": "Simple, embedded, no server needed" },
      { "$type": "LibraryDecision", "library": "better-sqlite3", "rationale": "Sync API fits the use case" }
    ]
  })

Rules:
- If you find nothing to extract from the events below, say "nothing to extract" and stop.
- Never call upsert_entries with empty entries like {}.
- Populate only fields whose values you can determine from the event data.
- Do not explain your work. Just call the tools and finish.
- More events will follow in subsequent messages. Process each batch as it arrives.

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
 * open across batches so the model accumulates context (subject to compression).
 * Thoughts are included in each batch's events naturally; older batches are
 * retained in the model's conversation history without explicit resending.
 */
export async function runSkillInteractive(opts: RunSkillInteractiveOptions): Promise<void> {
  const { skillName, skillPrompt, eventBatches, dbPath, queryOptions, pathToQwenExecutable, skillTypeNames, getTypeSchema } = opts;

  if (eventBatches.length === 0) return;

  console.log(`[runSkill] Starting interactive session for skill "${skillName}" (${eventBatches.length} batches)`);

  const mcpEnv: Record<string, string> = {
    RETRIVAL_DB_PATH: dbPath,
    RETRIVAL_INSERT: '1',
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
        ? buildIntroPrompt(skillName, skillPrompt, eventBatches[0]!, skillTypeNames, getTypeSchema)
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
