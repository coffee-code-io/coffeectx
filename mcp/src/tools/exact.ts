import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Db } from '@retrival-mcp/core';
import { formatDeepNode } from '@retrival-mcp/core';

/** Exact symbol match. */
export function registerExactTool(server: McpServer, db: Db): void {
  server.tool(
    'exact',
    'Find nodes that are symbols exactly equal to the given string. Returns the nearest named-type ancestor of each match.',
    {
      value: z.string().describe('Exact symbol value to match'),
      limit: z.number().int().min(1).max(500).default(50),
      offset: z.number().int().min(0).default(0).describe('Skip this many results (for pagination)'),
    },
    ({ value, limit, offset }) => {
      const allIds = db.querySymbolExact(value);
      const ids = allIds.slice(offset, offset + limit);
      const results = ids.map(id => {
        const parent = db.findNamedParent(id);
        if (parent) {
          try {
            const node = formatDeepNode(db.loadNodeDeep(parent.id, 3));
            return { id: parent.id, typeName: parent.typeName, node, matchedId: id };
          } catch { /* fall through */ }
        }
        return { id, node: db.loadNode(id) };
      });
      return {
        content: [{ type: 'text', text: JSON.stringify({ count: allIds.length, results }, null, 2) }],
      };
    },
  );
}
