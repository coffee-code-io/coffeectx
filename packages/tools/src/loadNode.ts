/**
 * Load a knowledge-graph node by id (or by timeline+version), expanding
 * the tree to a configurable depth.
 */

import type { Db } from '@coffeectx/core';
import { formatDeepNode } from '@coffeectx/core';

export const description =
  'Load a knowledge-graph node, expanding the tree to a configurable depth.\n' +
  '\n' +
  'Lookup modes:\n' +
  '  - `{ id }` — exact row by UUID. Returns whatever is at that id, including older versions or tombstoned (deleted) rows; this is the only way to inspect history.\n' +
  '  - `{ timelineId }` — current (latest-version) row of a timeline. Equivalent to `{ id }` for non-versioned nodes (where `id == timeline_id`). Returns the tombstoned row when the timeline has been deleted.\n' +
  '  - `{ timelineId, version }` — specific (timeline, version) tuple. Errors if that exact pair does not exist.\n' +
  '\n' +
  'Search tools (`search`, `regex`, `get_by_symbol_text`, `raw_query`) return only current, non-tombstoned versions. This is the escape hatch into the history layer.\n' +
  '\n' +
  'Container nodes beyond the depth limit are returned as `{ $id: id }` so you can load them separately.';

export interface Params {
  /** Exact-id lookup (returns this row, any version / tombstone state). */
  id?: string;
  /** Timeline-id lookup (returns current version unless `version` is set). */
  timelineId?: string;
  /** Optional specific version within `timelineId`. */
  version?: number;
  depth: number;
  verbose: boolean;
}

export interface Result {
  id: string;
  node: unknown;
}

export function run(db: Db, p: Params): Result {
  if (p.id) {
    const node = db.loadNodeDeep(p.id, p.depth);
    return { id: p.id, node: p.verbose ? node : formatDeepNode(node) };
  }
  if (p.timelineId) {
    if (p.version !== undefined) {
      const node = db.loadNodeAtVersion(p.timelineId, p.version, p.depth);
      const id = node.kind === 'map' && node.id ? node.id : p.timelineId;
      return { id, node: p.verbose ? node : formatDeepNode(node) };
    }
    const node = db.loadCurrentVersion(p.timelineId, p.depth);
    const id = node.kind === 'map' && node.id ? node.id : p.timelineId;
    return { id, node: p.verbose ? node : formatDeepNode(node) };
  }
  throw new Error('loadNode: provide either { id } or { timelineId } (with optional version)');
}
