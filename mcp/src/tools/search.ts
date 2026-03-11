import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Db } from '@retrival-mcp/core';
import { formatDeepNode } from '@retrival-mcp/core';

/** Semantic similarity search over meaning nodes. Returns the nearest named-type parent when available. */
export function registerSearchTool(server: McpServer, db: Db): void {
  server.tool(
    'search',
    'Search for nodes by semantic similarity to a natural-language query. Returns the nearest named-type ancestor of each match (e.g. the Decision or FunctionDef that contains the matched text). Log event nodes are excluded by default.',
    {
      query: z.string().describe('Natural language query'),
      limit: z.number().int().min(1).max(100).default(10),
      offset: z.number().int().min(0).default(0).describe('Skip this many results (for pagination)'),
      includeHidden: z.boolean().default(false).describe('Include log event nodes (UserInput, FileOperation, etc.) that are normally hidden'),
    },
    async ({ query, limit, offset, includeHidden }) => {
      // Over-fetch to compensate for hidden results being filtered out
      const fetchLimit = includeHidden ? limit : limit * 4;
      const results = await db.searchByText(query, fetchLimit, offset);
      const mapped: unknown[] = [];
      for (const r of results) {
        const parent = db.findNamedParent(r.nodeId);
        if (parent) {
          if (!includeHidden && db.isHiddenNamedType(parent.typeName)) continue;
          try {
            const node = formatDeepNode(db.loadNodeDeep(parent.id, 3));
            mapped.push({ id: parent.id, typeName: parent.typeName, distance: r.distance, node, matchedId: r.nodeId });
            if (mapped.length >= limit) break;
            continue;
          } catch { /* fall through */ }
        }
        if (!includeHidden) continue; // bare nodes with no named parent are skipped by default
        mapped.push({ id: r.nodeId, distance: r.distance, node: r.node });
        if (mapped.length >= limit) break;
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(mapped, null, 2) }],
      };
    },
  );
}
