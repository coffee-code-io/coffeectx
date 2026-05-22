import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Db } from '@coffeectx/core';
import { regex } from '@coffeectx/tools';

export function registerRegexTool(server: McpServer, db: Db): void {
  server.tool(
    'regex',
    regex.description,
    {
      pattern: z.string().describe('JavaScript RegExp pattern (case-insensitive), e.g. "^auth" or "cache"'),
      limit: z.number().int().min(1).max(500).default(50),
      offset: z.number().int().min(0).default(0).describe('Skip this many results (for pagination)'),
      includeHidden: z.boolean().default(false).describe('Include log event nodes (UserInput, FileOperation, etc.) that are normally hidden'),
    },
    ({ pattern, limit, offset, includeHidden }) => {
      const result = regex.run(db, { pattern, limit, offset, includeHidden });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );
}
