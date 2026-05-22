import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Db } from '@coffeectx/core';
import { upsertEntries } from '@coffeectx/tools';

export function registerUpsertEntriesTool(server: McpServer, db: Db): void {
  server.tool(
    'upsert_entries',
    upsertEntries.description,
    {
      entries: z
        .array(z.object({ $type: z.string(), $id: z.string().optional() }).catchall(z.unknown()))
        .min(1)
        .describe('Array of entries. "$type" is required. "$id" (string) patches an existing node.'),
    },
    async ({ entries }) => {
      try {
        const response = await upsertEntries.run(db, { entries: entries as upsertEntries.InsertEntryDTO[] });
        if (response.parseErrors) {
          return {
            content: [{ type: 'text', text: response.parseErrors.map(e => e.message).join('\n') }],
            isError: true,
          };
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(response.result, null, 2) }],
          isError: (response.result?.errors.length ?? 0) > 0,
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );
}
