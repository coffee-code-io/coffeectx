/**
 * Span linker — LSP symbols + Plan instances.
 *
 * For each Span we walk twice:
 *   1. LSP — for each filesChanged entry, gather symbol timelines whose
 *      latest version with `createdAt ≤ endedAt` is non-tombstoned. Append
 *      those ids into `touchedSymbols`.
 *   2. Plans — for each filesChanged entry, gather Plan nodes whose `path`
 *      matches and whose `createdAt` falls in `(startedAt, endedAt]` (the
 *      plan was minted during this span). Append those ids into
 *      `touchedPlans`.
 *
 * Both passes share one Span iteration and one terminal state bump
 * (`extracted → linked`). Already-`linked` spans get the repair pass for
 * either list when it's still empty — handles spans inserted before this
 * linker change.
 *
 * Runs as an `onNodeState` job on `Span:extracted`, with a fallback timer
 * for cases where the symbol/plan rows arrive after the span was first seen.
 */

import type { Db, DeepNode } from '@coffeectx/core';
import { SPAN_LINK_EPS_MS } from './spans.js';

const LSP_TYPES = [
  'LspModule', 'LspNamespace', 'LspClass',
  'LspMethod', 'LspConstructor', 'LspEnum', 'LspInterface', 'LspFunction',
];

export interface SpanLinkResult {
  scanned: number;
  linked: number;
  symbols: number;
  plans: number;
  errors: Array<{ spanId: string; error: string }>;
}

export async function linkSpans(db: Db, opts: { repoPath?: string } = {}): Promise<SpanLinkResult> {
  const result: SpanLinkResult = { scanned: 0, linked: 0, symbols: 0, plans: 0, errors: [] };

  const byFile = buildLspIndexByFile(db);
  const plansByPath = buildPlanIndexByPath(db);

  for (const spanId of db.queryByNamedType(['Span'])) {
    const state = db.getNodeState(spanId);
    if (state !== 'extracted' && state !== 'linked') continue;
    result.scanned += 1;
    try {
      const node = db.loadNodeDeep(spanId, 2);
      if (node.kind !== 'map') continue;
      const startedAt = parseNumeric(atomText(node.entries['startedAt']));
      const endedAt = parseNumeric(atomText(node.entries['endedAt']));
      if (endedAt == null) continue;
      // `effectiveEnd` is the linker's upper bound: extends endedAt by
      // SPAN_LINK_EPS_MS but never past the next span's start. Older spans
      // (inserted before the schema bump) lack the field — fall back to the
      // uncapped pad so legacy data still links.
      const effectiveEnd = parseNumeric(atomText(node.entries['effectiveEnd']))
        ?? endedAt + SPAN_LINK_EPS_MS;
      const filesChanged = collectListAtoms(node.entries['filesChanged']);
      const existingSymbolCount = countListItems(node.entries['touchedSymbols']);
      const existingPlanCount = countListItems(node.entries['touchedPlans']);

      const needsSymbols = state === 'extracted' || existingSymbolCount === 0;
      const needsPlans = state === 'extracted' || existingPlanCount === 0;
      if (!needsSymbols && !needsPlans) continue;

      // ── LSP pass ────────────────────────────────────────────────────────
      const symbolIds = needsSymbols
        ? gatherTouchedSymbols(filesChanged, effectiveEnd, byFile, opts.repoPath)
        : new Set<string>();

      // ── Plans pass ──────────────────────────────────────────────────────
      const planIds = needsPlans
        ? gatherTouchedPlans(filesChanged, startedAt, effectiveEnd, plansByPath)
        : new Set<string>();

      // No-op early exit for already-`linked` spans with nothing to add.
      if (state === 'linked' && symbolIds.size === 0 && planIds.size === 0) continue;

      let symbolsAdded = 0;
      let plansAdded = 0;
      if (symbolIds.size > 0) {
        const listId = db.getMapFieldId(spanId, 'touchedSymbols');
        if (listId) symbolsAdded = db.appendListItemsUnique(listId, [...symbolIds]);
        else result.errors.push({ spanId, error: 'touchedSymbols field missing' });
      }
      if (planIds.size > 0) {
        const listId = db.getMapFieldId(spanId, 'touchedPlans');
        if (listId) {
          plansAdded = db.appendListItemsUnique(listId, [...planIds]);
        } else {
          // Legacy span (predates `touchedPlans` on the Span schema). The
          // field is missing entirely, so an additive patch can introduce
          // it. Span's terminal state is immutable to plain patches; passing
          // `state: 'linked'` (the current state) satisfies the gate without
          // triggering a state-change.
          const ir = await db.insertEntries([{
            id: spanId,
            type: 'Span',
            data: { touchedPlans: [...planIds].map(id => ({ $id: id })) },
            ...(state === 'linked' ? { state: 'linked' } : {}),
          }]);
          if (ir.errors.length > 0) {
            result.errors.push({ spanId, error: ir.errors.map(e => `${e.path}: ${e.message}`).join('; ') });
          } else {
            plansAdded = planIds.size;
          }
        }
      }

      if (state === 'extracted') db.setNodeState(spanId, 'linked');
      result.linked += 1;
      result.symbols += symbolsAdded;
      result.plans += plansAdded;
    } catch (err) {
      result.errors.push({ spanId, error: (err as Error).message });
    }
  }

  return result;
}

// ── LSP indexing helpers ─────────────────────────────────────────────────────

interface LspIndexed {
  id: string;
  timelineId: string;
  version: number;
  createdAt: number | null;
  tombstone: boolean;
}

function buildLspIndexByFile(db: Db): Map<string, LspIndexed[]> {
  const out = new Map<string, LspIndexed[]>();
  // queryByNamedType returns only non-tombstoned current versions, but for
  // `touchedSymbols` at a past time we need every version — walk all
  // timelines through listTimelineVersions instead.
  const seenTimeline = new Set<string>();
  const headIds = db.queryByNamedType(LSP_TYPES);
  for (const headId of headIds) {
    try {
      const meta = (db as unknown as {
        raw: { prepare: (sql: string) => { get: (...args: unknown[]) => unknown } };
      }).raw.prepare(`SELECT timeline_id FROM nodes WHERE id = ?`).get(headId) as
        | { timeline_id: string } | undefined;
      const timelineId = meta?.timeline_id;
      if (!timelineId || seenTimeline.has(timelineId)) continue;
      seenTimeline.add(timelineId);
      // For each version of the timeline gather (id, file_path, createdAt,
      // tombstone). file_path is the same across versions of an LSP symbol
      // (renames produce a delete+new-timeline pair, not a rename).
      for (const row of db.listTimelineVersions(timelineId)) {
        const fp = readMapSymbol(db, row.id, 'file_path');
        if (!fp) continue;
        const bucket = out.get(fp) ?? [];
        bucket.push({
          id: row.id,
          timelineId,
          version: row.version,
          createdAt: row.createdAt,
          tombstone: row.tombstone,
        });
        out.set(fp, bucket);
      }
    } catch { /* best-effort */ }
  }
  return out;
}

function gatherTouchedSymbols(
  filesChanged: string[],
  cutoff: number,
  byFile: Map<string, LspIndexed[]>,
  repoPath: string | undefined,
): Set<string> {
  const out = new Set<string>();
  for (const rawPath of filesChanged) {
    // Historical spans stored absolute paths in `filesChanged` before the
    // indexer started relativizing them. Strip the repo prefix at lookup
    // time so the existing rows still match LSP file_path (always
    // repo-relative). New spans arrive already relativized.
    const relPath = relativizeForLookup(rawPath, repoPath);
    const symbols = byFile.get(relPath);
    if (!symbols) continue;
    // Group by timeline; pick the largest createdAt ≤ cutoff. The tombstone
    // flag means "superseded later" — only treat it as a real delete when
    // the picked version is also the timeline head.
    const byTimeline = new Map<string, LspIndexed>();
    const headVersion = new Map<string, number>();
    for (const s of symbols) {
      const prevHead = headVersion.get(s.timelineId) ?? -Infinity;
      if (s.version > prevHead) headVersion.set(s.timelineId, s.version);
      if (s.createdAt == null || s.createdAt > cutoff) continue;
      const prev = byTimeline.get(s.timelineId);
      if (!prev || s.createdAt > (prev.createdAt ?? -Infinity)) byTimeline.set(s.timelineId, s);
    }
    for (const s of byTimeline.values()) {
      const isHead = s.version === headVersion.get(s.timelineId);
      if (s.tombstone && isHead) continue;
      out.add(s.id);
    }
  }
  return out;
}

// ── Plan indexing helpers ────────────────────────────────────────────────────

interface PlanIndexed {
  id: string;
  /** Stored as the snapshot ts (set by the plans indexer at insert time). */
  createdAt: number | null;
}

function buildPlanIndexByPath(db: Db): Map<string, PlanIndexed[]> {
  const out = new Map<string, PlanIndexed[]>();
  for (const id of db.queryByNamedType(['Plan'])) {
    const path = readMapSymbol(db, id, 'path');
    if (!path) continue;
    const ts = db.getNodeTimestamps(id);
    const bucket = out.get(path) ?? [];
    bucket.push({ id, createdAt: ts?.createdAt ?? null });
    out.set(path, bucket);
  }
  return out;
}

function gatherTouchedPlans(
  filesChanged: string[],
  startedAt: number | null,
  effectiveEnd: number,
  plansByPath: Map<string, PlanIndexed[]>,
): Set<string> {
  const out = new Set<string>();
  for (const rawPath of filesChanged) {
    // Plan files live OUTSIDE repoPath (under ~/.claude/plans), so no
    // relativization is needed — the absolute path agent-tool inputs
    // produced is exactly what the plans indexer wrote into Plan.path.
    const plans = plansByPath.get(rawPath);
    if (!plans) continue;
    for (const p of plans) {
      if (p.createdAt == null) continue;
      if (startedAt != null && p.createdAt <= startedAt) continue;
      if (p.createdAt > effectiveEnd) continue;
      out.add(p.id);
    }
  }
  return out;
}

// ── Generic helpers ──────────────────────────────────────────────────────────

function readMapSymbol(db: Db, nodeId: string, key: string): string | null {
  const fid = db.getMapFieldId(nodeId, key);
  if (!fid) return null;
  const n = db.loadNode(fid);
  if (n.kind !== 'atom' || n.atom.kind !== 'symbol') return null;
  return n.atom.value;
}

function atomText(n: DeepNode | undefined): string | null {
  if (!n || n.kind !== 'atom') return null;
  if (n.atom.kind === 'symbol') return n.atom.value;
  if (n.atom.kind === 'meaning') return n.atom.value.text;
  return null;
}

function collectListAtoms(n: DeepNode | undefined): string[] {
  if (!n || n.kind !== 'list') return [];
  const out: string[] = [];
  for (const item of n.items) {
    const t = atomText(item);
    if (t != null) out.push(t);
  }
  return out;
}

function countListItems(n: DeepNode | undefined): number {
  if (!n || n.kind !== 'list') return 0;
  return n.items.length;
}

function parseNumeric(s: string | null): number | null {
  if (s == null) return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}

function relativizeForLookup(p: string, repoPath: string | undefined): string {
  if (!repoPath || !p) return p;
  const root = repoPath.endsWith('/') ? repoPath.slice(0, -1) : repoPath;
  if (p === root) return '';
  if (p.startsWith(root + '/')) return p.slice(root.length + 1);
  return p;
}
