/**
 * /api/p/:p/* — graph data: types, search, node detail, references.
 */

import type { FastifyInstance } from 'fastify';
import { parseQuery, executeQuery, formatDeepNode } from '@coffeectx/core';
import type { Db } from '@coffeectx/core';
import { getDb } from '../dbPool.js';

type SearchMode = 'query' | 'search' | 'regex' | 'exact';

interface NodeSummary {
  id: string;
  typeName: string | null;
  matchedId: string;
  summary: unknown;
  /** 0 = original match; >0 = neighbor reached after that many hops. */
  depth: number;
  isMatch: boolean;
}

/**
 * Map raw matched node IDs to "named parent" summaries.
 * - Each raw id climbs to the nearest named-type ancestor (or itself if it's a named root).
 * - If `includeHidden=false`, results whose parent type is hidden are dropped.
 * - Duplicate parents are deduped, preserving order of first appearance.
 * - Summary = formatDeepNode(loadNodeDeep(parentId, 3)) — small enough to render in a card.
 */
function namedParentsOf(
  db: Db,
  rawIds: string[],
  includeHidden: boolean,
): Map<string, { typeName: string; matchedId: string }> {
  const out = new Map<string, { typeName: string; matchedId: string }>();
  for (const id of rawIds) {
    let typeName = db.getNodeTypeName(id);
    let parentId = id;
    if (!typeName) {
      const parent = db.findNamedParent(id);
      if (!parent) continue;
      parentId = parent.id;
      typeName = parent.typeName;
    }
    if (!includeHidden && db.isHiddenNamedType(typeName)) continue;
    if (out.has(parentId)) continue;
    out.set(parentId, { typeName, matchedId: id });
  }
  return out;
}

function buildSummary(db: Db, id: string, typeName: string, matchedId: string, depth: number): NodeSummary | null {
  try {
    const node = db.loadNodeDeep(id, 3);
    return { id, typeName, matchedId, summary: formatDeepNode(node), depth, isMatch: depth === 0 };
  } catch {
    return null;
  }
}

/** BFS through outgoing named references up to `depth` hops. */
function expandByDepth(
  db: Db,
  seeds: Map<string, { typeName: string; matchedId: string }>,
  depth: number,
  includeHidden: boolean,
): NodeSummary[] {
  const out: NodeSummary[] = [];
  const seen = new Set<string>();

  // Depth 0 — the seeds themselves.
  for (const [id, meta] of seeds) {
    const s = buildSummary(db, id, meta.typeName, meta.matchedId, 0);
    if (s) { out.push(s); seen.add(id); }
  }

  if (depth <= 0) return out;

  let frontier: string[] = Array.from(seeds.keys());
  for (let hop = 1; hop <= depth && frontier.length > 0; hop++) {
    const next: string[] = [];
    for (const fromId of frontier) {
      const refs = db.collectOutgoingNamedRefs(fromId, 10);
      for (const r of refs) {
        if (seen.has(r.id)) continue;
        if (!includeHidden && db.isHiddenNamedType(r.typeName)) continue;
        seen.add(r.id);
        const s = buildSummary(db, r.id, r.typeName, r.id, hop);
        if (s) { out.push(s); next.push(r.id); }
      }
    }
    frontier = next;
  }
  return out;
}

export async function registerNodesRoutes(app: FastifyInstance): Promise<void> {
  // ── Types listing ─────────────────────────────────────────────────────────
  app.get<{ Params: { p: string } }>('/api/p/:p/types', async (req, reply) => {
    try {
      const db = getDb(req.params.p);
      return db.listNamedTypes().map(t => ({
        name: t.name,
        description: t.description,
        source: t.source,
        hidden: db.isHiddenNamedType(t.name),
      }));
    } catch (err) {
      reply.code(404);
      return { error: (err as Error).message };
    }
  });

  // ── Unified search/query/regex/exact + types intersection + depth expand ──
  app.get<{
    Params: { p: string };
    Querystring: {
      mode?: SearchMode;
      q?: string;
      types?: string;
      depth?: string;
      limit?: string;
      offset?: string;
      includeHidden?: string;
    };
  }>('/api/p/:p/nodes', async (req, reply) => {
    let db: Db;
    try { db = getDb(req.params.p); }
    catch (err) { reply.code(404); return { error: (err as Error).message }; }

    const mode = (req.query.mode ?? 'query') as SearchMode;
    const q = req.query.q?.trim() || undefined;
    const types = (req.query.types ?? '').split(',').map(s => s.trim()).filter(Boolean);
    const depth = clampInt(req.query.depth, 0, 0, 5);
    const limit = clampInt(req.query.limit, 50, 1, 500);
    const offset = clampInt(req.query.offset, 0, 0, 10_000);
    const includeHidden = req.query.includeHidden === 'true' || req.query.includeHidden === '1';

    // ── Run the text-based filter (if q is given) ───────────────────────────
    let qIds: string[] | null = null;
    if (q) {
      try {
        switch (mode) {
          case 'query': {
            const parsed = parseQuery(q);
            qIds = await executeQuery(parsed, db);
            break;
          }
          case 'search': {
            const fetchLimit = includeHidden ? limit + offset : (limit + offset) * 4;
            const results = await db.searchByText(q, fetchLimit, 0);
            qIds = results.map(r => r.nodeId);
            break;
          }
          case 'regex': {
            try { new RegExp(q); }
            catch { reply.code(400); return { error: `invalid regex: ${q}` }; }
            qIds = db.querySymbolRegex(q);
            break;
          }
          case 'exact': {
            qIds = db.querySymbolExact(q);
            break;
          }
          default:
            reply.code(400);
            return { error: `unknown mode "${mode}"` };
        }
      } catch (err) {
        reply.code(400);
        return { error: (err as Error).message };
      }
    }

    // ── Type filter (intersected with q, if both are given) ─────────────────
    const seeds = (() => {
      // Lift q-matches to their named-type parents.
      const qNamed = qIds === null ? null : namedParentsOf(db, qIds, includeHidden);
      if (types.length > 0) {
        const typeIds = db.queryByNamedType(types);
        const typeNamed = namedParentsOf(db, typeIds, includeHidden);
        if (qNamed === null) return typeNamed;
        // Intersect by parent id (preserve qNamed iteration order for stability).
        const out = new Map<string, { typeName: string; matchedId: string }>();
        for (const [id, meta] of qNamed) {
          if (typeNamed.has(id)) out.set(id, meta);
        }
        return out;
      }
      return qNamed ?? new Map();
    })();

    // ── Depth expansion via outgoing refs ───────────────────────────────────
    const all = expandByDepth(db, seeds, depth, includeHidden);
    const page = all.slice(offset, offset + limit);
    return { total: all.length, count: page.length, offset, results: page };
  });

  // ── Single node detail ────────────────────────────────────────────────────
  app.get<{ Params: { p: string; id: string }; Querystring: { depth?: string } }>(
    '/api/p/:p/nodes/:id',
    async (req, reply) => {
      let db: Db;
      try { db = getDb(req.params.p); }
      catch (err) { reply.code(404); return { error: (err as Error).message }; }

      const depth = clampInt(req.query.depth, 10, 0, 30);
      try {
        const node = db.loadNodeDeep(req.params.id, depth);
        const typeName = db.getNodeTypeName(req.params.id);
        return {
          id: req.params.id,
          typeName,
          node: formatDeepNode(node),
          raw: node,
        };
      } catch (err) {
        reply.code(404);
        return { error: (err as Error).message };
      }
    },
  );

  // ── References (in / out) — for the detail sidebar and graph edges ────────
  app.get<{ Params: { p: string; id: string } }>(
    '/api/p/:p/nodes/:id/refs',
    async (req, reply) => {
      let db: Db;
      try { db = getDb(req.params.p); }
      catch (err) { reply.code(404); return { error: (err as Error).message }; }

      const incoming = db.findReferencingNamedNodes(req.params.id, 100);
      const outgoing = db.collectOutgoingNamedRefs(req.params.id, 10);
      return { in: incoming, out: outgoing };
    },
  );
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined) return fallback;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
