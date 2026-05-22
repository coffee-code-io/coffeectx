/**
 * Run the retrival query language against the knowledge graph.
 */

import type { Db } from '@coffeectx/core';
import { parseQuery, executeQuery, formatDeepNode } from '@coffeectx/core';

export const SYNTAX = `
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

export const description = `Query the knowledge graph using the retrival query language.\n\nSyntax:\n${SYNTAX}`;

export interface Params {
  query: string;
  limit: number;
  offset: number;
  depth: number;
  verbose: boolean;
  includeHidden: boolean;
}

export interface Result {
  count: number;
  results: { id: string; node: unknown }[];
}

export async function run(db: Db, p: Params): Promise<Result> {
  const parsed = parseQuery(p.query); // throws on bad syntax — caller surfaces it
  const allIds = await executeQuery(parsed, db);
  const visibleIds = p.includeHidden
    ? allIds
    : allIds.filter(id => {
        // Named-type roots: own type decides visibility.
        const selfType = db.getNodeTypeName(id);
        if (selfType) return !db.isHiddenNamedType(selfType);
        // Internal nodes (fields, list items): check nearest named ancestor.
        const parent = db.findNamedParent(id);
        if (parent && db.isHiddenNamedType(parent.typeName)) return false;
        return true;
      });
  const ids = visibleIds.slice(p.offset, p.offset + p.limit);
  const results = ids.map(id => {
    try {
      const node = db.loadNodeDeep(id, p.depth);
      return { id, node: p.verbose ? node : formatDeepNode(node) };
    } catch {
      return { id, node: null };
    }
  });
  return { count: results.length, results };
}
