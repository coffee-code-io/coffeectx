import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Db } from '@retrival-mcp/core';

/** Semantic similarity search over meaning nodes. */
export function registerSearchTool(server: McpServer, db: Db): void {
  server.tool(
    'search',
    'Search for nodes by semantic similarity to a natural-language query. Returns meaning nodes ranked by embedding distance.',
    {
      query: z.string().describe('Natural language query'),
      limit: z.number().int().min(1).max(100).default(10),
    },
    async ({ query, limit }) => {
      const results = await db.searchByText(query, limit);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              results.map(r => ({ id: r.nodeId, distance: r.distance, node: r.node })),
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
