import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Db } from '@coffeectx/core';
import { formatDeepNode } from '@coffeectx/core';

/** Semantic similarity search over meaning nodes. Returns the nearest named-type parent when available. */
export function registerSearchTool(server: McpServer, db: Db): void {
  server.tool(
    'search',
    'Use this when you need to recall decisions, rationale, context, or knowledge about a topic but do not know the exact wording. ' +
      'Searches by semantic similarity — describe what you are trying to remember or understand in plain language. ' +
      'Returns the nearest named-type ancestor of each match (e.g. the Decision, LocalDecision, or FunctionDef that contains the matched meaning). ' +
      'Good triggers: "why was X chosen?", "what do we know about Y?", "past decisions around Z", "context for this change". ' +
      'Log event nodes are excluded by default.',
    {
      query: z.string().describe('Natural language description of the knowledge you are looking for'),
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
