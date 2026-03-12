import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Db } from '@coffeectx/core';
import { formatDeepNode } from '@coffeectx/core';

export function registerLoadNodeTool(server: McpServer, db: Db): void {
  server.tool(
    'get_node_by_id',
    'Load a knowledge-graph node by its UUID, expanding the tree to a configurable depth.\n' +
      'Use this when you already have a node ID — e.g. from a search result, a `$id` reference in another node, or a `matchedId` returned by another tool.\n' +
      'Container nodes beyond the depth limit are returned as `{ $id: id }` so you can load them separately.\n',
    {
      id: z.string().describe('Node UUID to load'),
      depth: z
        .number()
        .int()
        .min(0)
        .max(20)
        .default(10)
        .describe('How many container levels to expand (default 10; atoms always expanded)'),
      verbose: z
        .boolean()
        .default(false)
        .describe('Return raw DeepNode with full type definitions and vectors (default: compact form)'),
    },
    ({ id, depth, verbose }) => {
      let node;
      try {
        node = db.loadNodeDeep(id, depth);
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
          isError: true,
        };
      }
      const output = verbose ? { id, node } : { id, node: formatDeepNode(node) };
      return {
        content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
      };
    },
  );
}
