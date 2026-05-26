/**
 * Collect aux-table data the UI surfaces in "debug mode" on the
 * NodeDetail page. Only invoked when `config.debug === true`; callers
 * pass `undefined` through to the response so the client side stays
 * easy: render iff `data.debug !== undefined`.
 *
 * Two branches today, matching the two tables flagged as
 * "hidden from the MCP/UI graph" in packages/core/src/schema.ts:
 *
 *   - `event_file_context` — for agent-log events (UserInput,
 *     FileOperation, ShellExecution, AgentQuestion, AgentMessage,
 *     AgentSummary). Lists the file paths the indexer mapped to this
 *     event during agent-log enrichment.
 *   - `plan_acceptances` + the `getPlanFilePaths` join — for `Plan`
 *     nodes. Lists the sessions that ran ExitPlanMode against the plan
 *     plus the unioned `FileOperation.path` set those sessions touched.
 *
 * LSP symbol nodes are intentionally out of scope: the agent-log ↔ LSP
 * link is one-directional (events carry `relatedSymbols` /
 * `touchedSymbols` lists pointing AT symbols), so symbols have no
 * reverse aux-table data to surface. The existing Refs panel covers the
 * reverse direction via materialised `node_refs`.
 */

import type { Db, DeepNode } from '@coffeectx/core';

/** Shape mirrored on the client (webui/src/api/client.ts). */
export type NodeDebugInfo =
  | { kind: 'event'; filePaths: string[] }
  | {
      kind: 'plan';
      acceptances: { sessionId: string; timestamp: string }[];
      filePaths: string[];
    };

const EVENT_TYPES = new Set([
  'UserInput',
  'FileOperation',
  'ShellExecution',
  'AgentQuestion',
  'AgentMessage',
  'AgentSummary',
]);

export function collectDebugInfo(
  db: Db,
  id: string,
  typeName: string | null,
  node: DeepNode,
): NodeDebugInfo | undefined {
  if (!typeName) return undefined;

  if (EVENT_TYPES.has(typeName)) {
    const filePaths = db.getEventFileContext(id);
    return { kind: 'event', filePaths };
  }

  if (typeName === 'Plan') {
    // The plan's `name` field is the slug used as the FK in
    // plan_acceptances. Pull it off the deep-loaded node so we don't
    // have to round-trip another query.
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
