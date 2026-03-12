import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Db } from '@coffeectx/core';
import { formatDeepNode } from '@coffeectx/core';

/** Regex symbol match (case-insensitive). */
export function registerRegexTool(server: McpServer, db: Db): void {
  server.tool(
    'regex',
    'Use this when you know a partial name, prefix, or naming pattern and want to find everything matching it. ' +
      'Matches symbol values (and meaning text) against a case-insensitive JavaScript regular expression and returns the nearest named-type ancestor of each match. ' +
      'Good triggers: "all functions starting with auth", "files in the lsp/ folder", "any symbol containing the word cache", browsing a module\'s symbols by pattern. ' +
      'Log event nodes are excluded by default.',
    {
      pattern: z.string().describe('JavaScript RegExp pattern (case-insensitive), e.g. "^auth" or "cache"'),
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
