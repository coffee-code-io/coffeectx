import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Db } from '@retrival-mcp/core';

/** Regex symbol match (case-insensitive). */
export function registerRegexTool(server: McpServer, db: Db): void {
  server.tool(
    'regex',
    'Find symbol nodes whose value matches a JavaScript regular expression (case-insensitive).',
    {
      pattern: z.string().describe('JavaScript RegExp pattern, e.g. "^auth.*"'),
    },
    ({ pattern }) => {
      // Validate pattern before hitting the DB
      new RegExp(pattern);
      const ids = db.querySymbolRegex(pattern);
      const nodes = ids.map(id => ({ id, node: db.loadNode(id) }));
      return {
        content: [{ type: 'text', text: JSON.stringify(nodes, null, 2) }],
      };
    },
  );
}
