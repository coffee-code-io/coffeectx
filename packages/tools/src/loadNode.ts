/**
 * Load a knowledge-graph node by id, expanding to a configurable depth.
 */

import type { Db } from '@coffeectx/core';
import { formatDeepNode } from '@coffeectx/core';

export const description =
  'Load a knowledge-graph node by its UUID, expanding the tree to a configurable depth.\n' +
  'Use this when you already have a node ID — e.g. from a search result, a `$id` reference in another node, or a `matchedId` returned by another tool.\n' +
  'Container nodes beyond the depth limit are returned as `{ $id: id }` so you can load them separately.';

export interface Params {
  id: string;
  depth: number;
  verbose: boolean;
}

export interface Result {
  id: string;
  node: unknown;
}

export function run(db: Db, p: Params): Result {
  const node = db.loadNodeDeep(p.id, p.depth);
  return { id: p.id, node: p.verbose ? node : formatDeepNode(node) };
}
