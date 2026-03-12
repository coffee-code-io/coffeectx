import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Db } from '@coffeectx/core';

/**
 * Parse a flat "formatDeepNode-style" entry object into the InsertEntry shape
 * that db.insertEntries expects.
 *
 * Input format (same as formatDeepNode output):
 *   { "$type": "Decision", "$id"?: "uuid", field1: "value", field2: ["a","b"] }
 *
 * $type  — required; must be a registered named MapType
 * $id    — optional; if present, patch that existing node instead of creating new
 * Other keys — field values: string (symbol/meaning) or string[] (list)
 */
function parseEntry(raw: Record<string, unknown>, index: number): { ok: true; entry: { type: string; id?: string; data: Record<string, unknown> } } | { ok: false; error: string } {
  const $type = raw['$type'];
  if (typeof $type !== 'string' || $type === '') {
    return { ok: false, error: `Entry[${index}] missing required "$type" field` };
  }
  const $id = raw['$id'];
  if ($id !== undefined && typeof $id !== 'string') {
    return { ok: false, error: `Entry[${index}] "$id" must be a string` };
  }
  // Extract data: everything except $type and $id
  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === '$type' || k === '$id') continue;
    data[k] = v;
  }
  return { ok: true, entry: { type: $type, id: $id as string | undefined, data } };
}

export function registerUpsertEntriesTool(server: McpServer, db: Db): void {
  server.tool(
    'upsert_entries',
    `Insert or patch typed nodes in the knowledge graph.

Each entry is a plain JSON object in the same format that \`get_node_by_id\` and \`raw_query\` return:
  - \`$type\` (required) — named MapType to validate against
  - \`$id\`   (optional) — UUID of an existing node to patch instead of creating new
  - other keys — field values (string for Symbol/Meaning fields, string[] for List fields)

Omit \`$id\` to create a new node (all required fields must be present).
Provide \`$id\` to patch an existing node — only absent fields are added; existing keys are left untouched.

Embeddings for Meaning fields are computed automatically.
Cross-references within the batch: use \`{ "$ref": N }\` as a value, where N is the 0-based index of another entry.

Returns node IDs and per-field errors. Errors include the full list of available field names so you can correct and retry.

Examples:
  Create a new Decision:
    { "$type": "Decision", "title": "Use SQLite", "rationale": "Simple, embedded, no server needed" }

  Patch an existing node with missing fields:
    { "$type": "Decision", "$id": "a3f2...", "context": "Chosen after evaluating Postgres and DynamoDB" }

  Batch with a cross-reference (entry 1 references entry 0):
    [
      { "$type": "File", "path": "src/db.ts" },
      { "$type": "FunctionDef", "name": "insertNode", "file": { "$ref": 0 } }
    ]`,
    {
      entries: z
        .array(z.object({ $type: z.string(), $id: z.string().optional() }).catchall(z.unknown()))
        .min(1)
        .describe('Array of entries. "$type" is required. "$id" (string) patches an existing node.'),
    },
    async ({ entries }) => {
      // Parse entries, collecting parse errors
      const insertEntries: Array<{ type: string; id?: string; data: Record<string, unknown> }> = [];
      const parseErrors: string[] = [];
      for (let i = 0; i < entries.length; i++) {
        const parsed = parseEntry(entries[i]!, i);
        if (!parsed.ok) {
          parseErrors.push(parsed.error);
          // Push a placeholder so index alignment is preserved (db will also error on it)
          insertEntries.push({ type: '', data: {} });
        } else {
          insertEntries.push(parsed.entry);
        }
      }

      if (parseErrors.length > 0) {
        return {
          content: [{ type: 'text', text: parseErrors.join('\n') }],
          isError: true,
        };
      }

      let result;
      try {
        result = await db.insertEntries(insertEntries);
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        isError: result.errors.length > 0,
      };
    },
  );
}
