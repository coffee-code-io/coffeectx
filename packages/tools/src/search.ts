/**
 * Semantic similarity search over meaning nodes.
 * Returns the nearest named-type parent when available.
 */

import type { Db } from '@coffeectx/core';
import { formatDeepNode } from '@coffeectx/core';

export const description =
  'Use this when you need to recall decisions, rationale, context, or knowledge about a topic but do not know the exact wording. ' +
  'Searches by semantic similarity — describe what you are trying to remember or understand in plain language. ' +
  'Returns the nearest named-type ancestor of each match (e.g. the Decision, LocalDecision, or FunctionDef that contains the matched meaning). ' +
  'Good triggers: "why was X chosen?", "what do we know about Y?", "past decisions around Z", "context for this change". ' +
  'Log event nodes are excluded by default.';

export interface Params {
  query: string;
  limit: number;
  offset: number;
  includeHidden: boolean;
}

export async function run(db: Db, p: Params): Promise<unknown[]> {
  // Over-fetch to compensate for hidden results being filtered out.
  const fetchLimit = p.includeHidden ? p.limit : p.limit * 4;
  const results = await db.searchByText(p.query, fetchLimit, p.offset);
  const mapped: unknown[] = [];
  for (const r of results) {
    const parent = db.findNamedParent(r.nodeId);
    if (parent) {
      if (!p.includeHidden && db.isHiddenNamedType(parent.typeName)) continue;
      try {
        const node = formatDeepNode(db.loadNodeDeep(parent.id, 3));
        mapped.push({ id: parent.id, typeName: parent.typeName, distance: r.distance, node, matchedId: r.nodeId });
        if (mapped.length >= p.limit) break;
        continue;
      } catch { /* fall through */ }
    }
    if (!p.includeHidden) continue;
    mapped.push({ id: r.nodeId, distance: r.distance, node: r.node });
    if (mapped.length >= p.limit) break;
  }
  return mapped;
}
