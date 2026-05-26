import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Db } from '@coffeectx/core';
import { loadNode } from '@coffeectx/tools';

export function registerLoadNodeTool(server: McpServer, db: Db): void {
  server.tool(
    'get_node_by_id',
    loadNode.description,
    {
      id: z.string().optional().describe('Exact node UUID. Returns this exact row (any version, tombstone-agnostic).'),
      timelineId: z.string().optional().describe('Timeline UUID. Returns the current (latest-version) row unless `version` is also set.'),
      version: z.number().int().min(1).optional().describe('When set with `timelineId`, returns the specific (timeline, version) tuple.'),
      depth: z.number().int().min(0).max(20).default(10).describe('How many container levels to expand (default 10; atoms always expanded)'),
      verbose: z.boolean().default(false).describe('Return raw DeepNode with full type definitions and vectors (default: compact form)'),
    },
    ({ id, timelineId, version, depth, verbose }) => {
      try {
        const result = loadNode.run(db, { id, timelineId, version, depth, verbose });
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
