import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Db } from '@retrival-mcp/core';

export function registerInsertTool(server: McpServer, db: Db): void {
  server.tool(
    'insert',
    `Insert a single typed node into the knowledge graph.

Accepts one entry in the same flat JSON format as \`insert_entries\`:
  - \`$type\` (required) — named MapType to validate against
  - other keys — field values (string for Symbol/Meaning, string[] for List)

All required (non-optional) fields must be present.
Embeddings for Meaning fields are computed automatically.
Returns \`{ id }\` on success or an error with the list of missing/invalid fields.

For batch inserts or patching existing nodes, use \`insert_entries\`.

Examples:
  { "$type": "Decision", "title": "Use SQLite", "rationale": "Simple, embedded" }
  { "$type": "FunctionDef", "name": "parseQuery", "file": "src/query.ts", "tags": ["parser", "core"] }`,
    {
      entry: z
        .record(z.unknown())
        .describe('Entry object with required "$type" and field values'),
    },
    async ({ entry }) => {
      const $type = entry['$type'];
      if (typeof $type !== 'string' || $type === '') {
        return {
          content: [{ type: 'text', text: 'Error: entry missing required "$type" field' }],
          isError: true,
        };
      }

      const data: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(entry)) {
        if (k === '$type') continue;
        data[k] = v;
      }

      let result;
      try {
        result = await db.insertEntries([{ type: $type, data }]);
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }

      if (result.errors.length > 0) {
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text', text: JSON.stringify({ id: result.ids[0] }) }],
      };
    },
  );
}
