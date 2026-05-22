import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Db } from '@coffeectx/core';
import { loadNode } from '@coffeectx/tools';

export function registerLoadNodeTool(server: McpServer, db: Db): void {
  server.tool(
    'get_node_by_id',
    loadNode.description,
    {
      id: z.string().describe('Node UUID to load'),
      depth: z.number().int().min(0).max(20).default(10).describe('How many container levels to expand (default 10; atoms always expanded)'),
      verbose: z.boolean().default(false).describe('Return raw DeepNode with full type definitions and vectors (default: compact form)'),
    },
    ({ id, depth, verbose }) => {
      try {
        const result = loadNode.run(db, { id, depth, verbose });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );
}
