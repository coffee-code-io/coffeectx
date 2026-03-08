import { query } from '@qwen-code/sdk';
import type { QueryOptions } from '@qwen-code/sdk';
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
    // SDK package is at <monorepo>/packages/sdk-typescript/
    // The built CLI is at <monorepo>/dist/cli.js
    const monorepoCliPath = join(pkgDir, '..', '..', 'dist', 'cli.js');
    if (existsSync(monorepoCliPath)) return monorepoCliPath;
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
  /**
   * Names of entry types this skill is expected to create.
   * Optional; if provided, type schemas will be included in the prompt.
   */
  skillTypeNames?: string[];
  /**
   * Function to load and format type information.
   * Optional; required if skillTypeNames is provided.
   */
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

/**
 * Run a single qwen session for one skill batch.
 *
 * Qwen is launched in yolo mode but with file-editing tools excluded —
 * it can only interact with the knowledge graph via MCP insert/annotate tools.
 * The function resolves when the qwen process has finished.
 */
export async function runSkill(opts: RunSkillOptions): Promise<void> {
  const { skillName, skillPrompt, eventsText, dbPath, queryOptions, pathToQwenExecutable, skillTypeNames, getTypeSchema } = opts;

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

  // Build type schema section of prompt if types are provided
  let typeSchemaSection = '';
  if (skillTypeNames && skillTypeNames.length > 0 && getTypeSchema) {
    const typeSchemas: string[] = [];
    for (const typeName of skillTypeNames) {
      const schema = getTypeSchema(typeName);
      if (schema) {
        typeSchemas.push(`${typeName} — schema:\n${schema}\n  Example insert_entries call:\n  { "entries": [{ "$type": "${typeName}", "fieldName": "value", ... }] }`);
      }
    }
    if (typeSchemas.length > 0) {
      typeSchemaSection = `

## Entry Types You Must Create

Each entry passed to insert_entries MUST be a JSON object with:
  - "$type": the type name (string, REQUIRED — without it the call will fail)
  - field keys: values extracted from the event data (strings or arrays of strings)

Types and their schemas:

${typeSchemas.join('\n\n')}
`;
    }
  }

  const prompt = `You are working with a software project knowledge graph.

Skill: ${skillName}

Instructions:
${skillPrompt}${typeSchemaSection}

## How to call insert_entries

The tool accepts an "entries" array. Each entry is a flat JSON object where "$type" identifies the named type and the remaining keys are field values. "$type" is REQUIRED — the call will be rejected without it.

Example (two entries in one call):
  insert_entries({
    entries: [
      { "$type": "Decision", "title": "Use SQLite for storage", "rationale": "Simple, embedded, no server needed" },
      { "$type": "LibraryDecision", "library": "better-sqlite3", "rationale": "Sync API fits the use case" }
    ]
  })

Rules:
- If you find nothing to extract from the events below, stop immediately — do not call any tools.
- Never call insert_entries with an empty entry like {}.
- Populate only fields whose values you can determine from the event data.
- Do not explain your work. Just call the tools and finish.

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
