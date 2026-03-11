import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Db } from '@retrival-mcp/core';
import { formatDeepNode } from '@retrival-mcp/core';

/** Regex symbol match (case-insensitive). */
export function registerRegexTool(server: McpServer, db: Db): void {
  server.tool(
    'regex',
    'Find symbol nodes whose value matches a JavaScript regular expression (case-insensitive). Returns the nearest named-type ancestor of each match. Log event nodes are excluded by default.',
    {
      pattern: z.string().describe('JavaScript RegExp pattern, e.g. "^auth.*"'),
      limit: z.number().int().min(1).max(500).default(50),
      offset: z.number().int().min(0).default(0).describe('Skip this many results (for pagination)'),
      includeHidden: z.boolean().default(false).describe('Include log event nodes (UserInput, FileOperation, etc.) that are normally hidden'),
    },
    ({ pattern, limit, offset, includeHidden }) => {
      // Validate pattern before hitting the DB
      new RegExp(pattern);
      const allIds = db.querySymbolRegex(pattern);
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
