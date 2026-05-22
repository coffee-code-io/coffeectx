import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Db } from '@coffeectx/core';
import { exact } from '@coffeectx/tools';

export function registerExactTool(server: McpServer, db: Db): void {
  server.tool(
    'get_by_symbol_text',
    exact.description,
    {
      value: z.string().describe('Exact symbol text — the name, path, or identifier to look up'),
      limit: z.number().int().min(1).max(500).default(50),
      offset: z.number().int().min(0).default(0).describe('Skip this many results (for pagination)'),
      includeHidden: z.boolean().default(false).describe('Include log event nodes (UserInput, FileOperation, etc.) that are normally hidden'),
    },
    ({ value, limit, offset, includeHidden }) => {
      const result = exact.run(db, { value, limit, offset, includeHidden });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );
}
