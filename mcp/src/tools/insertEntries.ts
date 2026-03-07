import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Db } from '@retrival-mcp/core';

const EntrySchema = z.object({
  type: z.string().describe('Named type for this entry (must be a MapType)'),
  data: z.record(z.unknown()).describe(
    'Field values. Use { "$ref": N } to reference the N-th entry in this batch.',
  ),
});

export function registerInsertEntriesTool(server: McpServer, db: Db): void {
  server.tool(
    'insert_entries',
    `Insert one or more typed nodes into the knowledge graph.

Each entry must reference a named MapType. Field values are validated and coerced
to the correct node kind (symbol, meaning, list, or nested map) automatically.

Circular references within the batch are supported via { "$ref": N } where N is
the 0-based index of the target entry in the entries array.

Returns the inserted node IDs (null where an entry failed validation) plus any
per-field errors.`,
    {
      entries: z.array(EntrySchema).min(1).describe('Entries to insert'),
    },
    async ({ entries }) => {
      let result;
      try {
        result = await db.insertEntries(entries);
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
