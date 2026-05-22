/**
 * Regex symbol match (case-insensitive), lifted to nearest named-type ancestor.
 */

import type { Db } from '@coffeectx/core';
import { formatDeepNode } from '@coffeectx/core';

export const description =
  'Use this when you know a partial name, prefix, or naming pattern and want to find everything matching it. ' +
  'Matches symbol values (and meaning text) against a case-insensitive JavaScript regular expression and returns the nearest named-type ancestor of each match. ' +
  'Good triggers: "all functions starting with auth", "files in the lsp/ folder", "any symbol containing the word cache", browsing a module\'s symbols by pattern. ' +
  'Log event nodes are excluded by default.';

export interface Params {
  pattern: string;
  limit: number;
  offset: number;
  includeHidden: boolean;
}

export interface Result {
  count: number;
  results: unknown[];
}

export function run(db: Db, p: Params): Result {
  // Validate pattern before hitting the DB.
  new RegExp(p.pattern);
  const allIds = db.querySymbolRegex(p.pattern);
  const visibleIds = p.includeHidden
    ? allIds
    : allIds.filter(id => {
        const parent = db.findNamedParent(id);
        return !parent || !db.isHiddenNamedType(parent.typeName);
      });
  const ids = visibleIds.slice(p.offset, p.offset + p.limit);
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
  return { count: visibleIds.length, results };
}
