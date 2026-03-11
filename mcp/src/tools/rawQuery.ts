import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Db } from '@retrival-mcp/core';
import { parseQuery, executeQuery, formatDeepNode } from '@retrival-mcp/core';

const SYNTAX = `
Query       = Clause (',' Clause)*                          AND semantics
Clause      = 'Symbol'  STRING                              exact symbol match
            | 'Regex'   STRING                              regex on symbol (case-insensitive)
            | 'Meaning' STRING                              semantic similarity search
            | 'Id'      STRING                              exact node ID lookup
            | TypeQuery                                     filter by named type
            | MapQuery                                      filter map nodes by field contents
            | ListQuery                                     filter list nodes by items
            | '(' Query ')'                                 grouping

TypeQuery   = 'IsType' STRING (',' 'IsType' STRING)*        OR semantics; STRING is named type
MapQuery    = 'Field' STRING SubQuery (',' 'Field' STRING SubQuery)*
ListQuery   = 'HasItem' SubQuery
SubQuery    = '(' Query ')' | Clause

Examples:
  Symbol "main"
  Meaning "authentication flow"
  IsType "Project", Field "title" Meaning "auth"
  Field "tags" Symbol "security", Field "author" Regex "^alice"
  HasItem (Symbol "step1"), IsType "Workflow"
`.trim();

export function registerRawQueryTool(server: McpServer, db: Db): void {
  server.tool(
    'raw_query',
    `Query the knowledge graph using the retrival query language.\n\nSyntax:\n${SYNTAX}`,
    {
      query: z.string().describe('Query expression in the retrival query language'),
      limit: z.number().int().min(1).max(500).default(50).describe('Max nodes to return'),
      offset: z.number().int().min(0).default(0).describe('Skip this many results (for pagination)'),
      depth: z.number().int().min(0).max(20).default(10).describe('How many container levels to expand per node (default 10)'),
      verbose: z.boolean().default(false).describe('Return raw DeepNode with full type definitions and vectors (default: compact form)'),
      includeHidden: z.boolean().default(false).describe('Include log event nodes (UserInput, FileOperation, etc.) that are normally hidden'),
    },
    async ({ query, limit, offset, depth, verbose, includeHidden }) => {
      let parsed;
      try {
        parsed = parseQuery(query);
      } catch (err) {
        return {
          content: [
            {
              type: 'text',
              text: `Parse error: ${(err as Error).message}\n\nSyntax reference:\n${SYNTAX}`,
            },
          ],
          isError: true,
        };
      }

      const allIds = await executeQuery(parsed, db);
      const visibleIds = includeHidden
        ? allIds
        : allIds.filter(id => {
            // If the node itself is a named-type root, its own type decides visibility.
            // Don't walk up to ancestors — they may be hidden for unrelated reasons.
            const selfType = db.getNodeTypeName(id);
            if (selfType) return !db.isHiddenNamedType(selfType);
            // For internal nodes (fields, list items), check the nearest named ancestor.
            const parent = db.findNamedParent(id);
            if (parent && db.isHiddenNamedType(parent.typeName)) return false;
            return true;
          });
      const ids = visibleIds.slice(offset, offset + limit);
      const results = ids.map(id => {
        try {
          const node = db.loadNodeDeep(id, depth);
          return { id, node: verbose ? node : formatDeepNode(node) };
        } catch {
          return { id, node: null };
        }
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ count: results.length, results }, null, 2),
          },
        ],
      };
    },
  );
}
