/**
 * Collect aux-table data the UI surfaces in "debug mode" on the
 * NodeDetail page. Only invoked when `config.debug === true`; callers
 * pass `undefined` through to the response so the client side stays
 * easy: render iff `data.debug !== undefined`.
 *
 * One branch today: `Plan` nodes get a `plan_acceptances` summary plus
 * the unioned `FileOperation.path` set the accepting sessions touched.
 */

import type { Db, DeepNode } from '@coffeectx/core';

/** Shape mirrored on the client (webui/src/api/client.ts). */
export type NodeDebugInfo = {
  kind: 'plan';
  acceptances: { sessionId: string; timestamp: string }[];
  filePaths: string[];
};

export function collectDebugInfo(
  db: Db,
  _id: string,
  typeName: string | null,
  node: DeepNode,
): NodeDebugInfo | undefined {
  if (!typeName) return undefined;

  if (typeName === 'Plan') {
    const slug = readPlanSlug(node);
    if (!slug) return undefined;
    const acceptances = db.getAcceptingSessions(slug);
    const filePaths = db.getPlanFilePaths(slug);
    return { kind: 'plan', acceptances, filePaths };
  }

  return undefined;
}

/** Pull the `name` Symbol off a deep-loaded Plan node, if present. */
function readPlanSlug(node: DeepNode): string | null {
  if (node.kind !== 'map') return null;
  const nameField = node.entries['name'];
  if (!nameField || nameField.kind !== 'atom') return null;
  if (nameField.atom.kind !== 'symbol') return null;
  return nameField.atom.value;
}
