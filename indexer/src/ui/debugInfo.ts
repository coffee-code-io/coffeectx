/**
 * Collect aux-table data the UI surfaces in "debug mode" on the
 * NodeDetail page. Only invoked when `config.debug === true`; callers
 * pass `undefined` through to the response so the client side stays
 * easy: render iff `data.debug !== undefined`.
 *
 * Today this is one branch: the per-node JSON blob stashed via
 * `db.debugSet(nodeId, field, value)`. Pipeline stages opt-in to
 * instrumentation by sprinkling those calls; this collector reads them
 * back. No type-specific aux any more — Plan-flavoured aux was
 * superseded by Spans + `touchedSymbols`.
 */

import type { Db } from '@coffeectx/core';

/** Shape mirrored on the client (webui/src/api/client.ts). */
export type NodeDebugInfo = { debug: Record<string, unknown> };

export function collectDebugInfo(db: Db, id: string): NodeDebugInfo | undefined {
  const debug = db.getNodeDebug(id);
  if (!debug || Object.keys(debug).length === 0) return undefined;
  return { debug };
}
