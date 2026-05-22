import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Db } from '@coffeectx/core';
import { search } from '@coffeectx/tools';

export function registerSearchTool(server: McpServer, db: Db): void {
  server.tool(
    'search',
    search.description,
    {
      query: z.string().describe('Natural language description of the knowledge you are looking for'),
      limit: z.number().int().min(1).max(100).default(10),
      offset: z.number().int().min(0).default(0).describe('Skip this many results (for pagination)'),
      includeHidden: z.boolean().default(false).describe('Include log event nodes (UserInput, FileOperation, etc.) that are normally hidden'),
    },
    async ({ query, limit, offset, includeHidden }) => {
      const result = await search.run(db, { query, limit, offset, includeHidden });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );
}
