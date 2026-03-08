import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Db } from '@retrival-mcp/core';

export function registerAnnotateNodeTool(server: McpServer, db: Db): void {
  server.tool(
    'annotate_node',
    `Patch absent fields on an existing map node without recreating it.

Useful for enriching previously-indexed nodes (LSP symbols, log events) with
optional metadata: semantic comments, cross-references, tags, etc.

Only fields that are NOT already set on the node are written. Existing values
are never overwritten. Unknown field names (not in the node's schema) are
rejected with an error entry.

Field values follow the same rules as insert_entries:
  - Symbol fields:   plain string
  - Meaning fields:  plain string (embedding is computed automatically)
  - List fields:     array of strings (items are inserted as symbol nodes)

Returns { patched, skipped, errors } listing which keys were added, already
present, or invalid.`,
    {
      id: z.string().describe('ID of the map node to annotate'),
      fields: z
        .record(z.union([z.string(), z.array(z.string())]))
        .describe('Field values to patch in (string for scalar, string[] for list)'),
    },
    async ({ id, fields }) => {
      let result;
      try {
        result = await db.annotateMapNode(id, fields);
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
