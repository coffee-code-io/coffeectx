import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Db } from '@retrival-mcp/core';
import { formatDeepNode } from '@retrival-mcp/core';

/** Semantic similarity search over meaning nodes. Returns the nearest named-type parent when available. */
export function registerSearchTool(server: McpServer, db: Db): void {
  server.tool(
    'search',
    'Search for nodes by semantic similarity to a natural-language query. Returns the nearest named-type ancestor of each match (e.g. the Decision or FunctionDef that contains the matched text).',
    {
      query: z.string().describe('Natural language query'),
      limit: z.number().int().min(1).max(100).default(10),
      offset: z.number().int().min(0).default(0).describe('Skip this many results (for pagination)'),
    },
    async ({ query, limit, offset }) => {
      const results = await db.searchByText(query, limit, offset);
      const mapped = results.map(r => {
        const parent = db.findNamedParent(r.nodeId);
        if (parent) {
          try {
            const node = formatDeepNode(db.loadNodeDeep(parent.id, 3));
            return { id: parent.id, typeName: parent.typeName, distance: r.distance, node, matchedId: r.nodeId };
          } catch { /* fall through */ }
        }
        return { id: r.nodeId, distance: r.distance, node: r.node };
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(mapped, null, 2) }],
      };
    },
  );
}
