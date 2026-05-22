import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Db } from '@coffeectx/core';
import { rawQuery } from '@coffeectx/tools';

export function registerRawQueryTool(server: McpServer, db: Db): void {
  server.tool(
    'raw_query',
    rawQuery.description,
    {
      query: z.string().describe('Query expression in the retrival query language'),
      limit: z.number().int().min(1).max(500).default(50).describe('Max nodes to return'),
      offset: z.number().int().min(0).default(0).describe('Skip this many results (for pagination)'),
      depth: z.number().int().min(0).max(20).default(10).describe('How many container levels to expand per node (default 10)'),
      verbose: z.boolean().default(false).describe('Return raw DeepNode with full type definitions and vectors (default: compact form)'),
      includeHidden: z.boolean().default(false).describe('Include log event nodes (UserInput, FileOperation, etc.) that are normally hidden'),
    },
    async ({ query, limit, offset, depth, verbose, includeHidden }) => {
      try {
        const result = await rawQuery.run(db, { query, limit, offset, depth, verbose, includeHidden });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return {
          content: [
            {
              type: 'text',
              text: `Parse error: ${(err as Error).message}\n\nSyntax reference:\n${rawQuery.SYNTAX}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
