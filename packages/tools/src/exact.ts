/**
 * Exact symbol match — find nodes by symbol text, lifted to nearest named-type ancestor.
 */

import type { Db } from '@coffeectx/core';
import { formatDeepNode } from '@coffeectx/core';

export const description =
  'Use this when you know the exact name, path, label, or identifier of something and want to retrieve the recorded knowledge about it. ' +
  'Looks up nodes whose symbol value exactly equals the given string and returns the nearest named-type ancestor (e.g. the LspFunction, Decision, or File that owns that symbol). ' +
  'Good triggers: looking up a function by name, finding what is known about a specific file, retrieving a node whose name appears in the code or conversation. ' +
  'Log event nodes are excluded by default.';

export interface Params {
  value: string;
  limit: number;
  offset: number;
  includeHidden: boolean;
}

export interface Result {
  count: number;
  results: unknown[];
}

export function run(db: Db, p: Params): Result {
  const allIds = db.querySymbolExact(p.value);
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
