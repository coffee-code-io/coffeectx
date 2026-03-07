import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Db } from '@retrival-mcp/core';

/** Exact symbol match. */
export function registerExactTool(server: McpServer, db: Db): void {
  server.tool(
    'exact',
    'Find nodes that are symbols exactly equal to the given string.',
    {
      value: z.string().describe('Exact symbol value to match'),
    },
    ({ value }) => {
      const ids = db.querySymbolExact(value);
      const nodes = ids.map(id => ({ id, node: db.loadNode(id) }));
      return {
        content: [{ type: 'text', text: JSON.stringify(nodes, null, 2) }],
      };
    },
  );
}
