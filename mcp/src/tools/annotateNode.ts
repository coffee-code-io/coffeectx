import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Db } from '@retrival-mcp/core';

export function registerAnnotateNodeTool(server: McpServer, db: Db): void {
  server.tool(
    'annotate_node',
    `Patch absent fields on an existing map node.

Accepts a single entry in the same format as \`insert_entries\`:
  - \`$type\` (required) — named type of the node (must match the node's actual type)
  - \`$id\`   (required) — UUID of the existing node to patch
  - other keys — field values to add (string for Symbol/Meaning, string[] for List)

Only fields NOT already present on the node are written. Existing values are never overwritten.
Unknown field names (not in the node's schema) are rejected.
Embeddings for Meaning fields are computed automatically.

Returns \`{ patched, skipped, errors }\` listing which keys were added, already present, or invalid.

Examples:
  Add a missing rationale to an existing Decision node:
    { "$type": "Decision", "$id": "a3f2c1...", "rationale": "Chosen for simplicity and zero-config deployment" }

  Annotate a FileOperation event with inferred intent:
    { "$type": "FileOperation", "$id": "b9e0...", "intent": "Refactoring database layer" }`,
    {
      entry: z
        .record(z.unknown())
        .describe('Entry with required "$type" and "$id", plus fields to add'),
    },
    async ({ entry }) => {
      const $type = entry['$type'];
      const $id = entry['$id'];

      if (typeof $type !== 'string' || $type === '') {
        return {
          content: [{ type: 'text', text: 'Error: entry missing required "$type" field' }],
          isError: true,
        };
      }
      if (typeof $id !== 'string' || $id === '') {
        return {
          content: [{ type: 'text', text: 'Error: annotate_node requires "$id" (the UUID of the node to patch)' }],
          isError: true,
        };
      }

      const data: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(entry)) {
        if (k === '$type' || k === '$id') continue;
        data[k] = v;
      }

      let result;
      try {
        result = await db.annotateMapNode($id, data);
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
