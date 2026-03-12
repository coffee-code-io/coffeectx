import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Db } from '@retrival-mcp/core';
import { formatDeepNode } from '@retrival-mcp/core';

/** Exact symbol match — find nodes by symbol text. */
export function registerExactTool(server: McpServer, db: Db): void {
  server.tool(
    'get_by_symbol_text',
    'Find knowledge-graph nodes whose symbol value exactly equals the given string. Returns the nearest named-type ancestor of each match. Use this to look up a known name, ID, path, or label. Log event nodes are excluded by default.',
    {
      value: z.string().describe('Exact symbol text to match'),
      limit: z.number().int().min(1).max(500).default(50),
      offset: z.number().int().min(0).default(0).describe('Skip this many results (for pagination)'),
      includeHidden: z.boolean().default(false).describe('Include log event nodes (UserInput, FileOperation, etc.) that are normally hidden'),
    },
    ({ value, limit, offset, includeHidden }) => {
      const allIds = db.querySymbolExact(value);
      const visibleIds = includeHidden
        ? allIds
        : allIds.filter(id => {
            const parent = db.findNamedParent(id);
            return !parent || !db.isHiddenNamedType(parent.typeName);
          });
      const ids = visibleIds.slice(offset, offset + limit);
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
        content: [{ type: 'text', text: JSON.stringify({ count: visibleIds.length, results }, null, 2) }],
      };
    },
  );
}
