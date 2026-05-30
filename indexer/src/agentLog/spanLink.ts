/**
 * Span → LSP linker.
 *
 * For each Span in state `extracted`:
 *   1. Read `filesChanged` (relative paths) and `endedAt` (unix ms).
 *   2. For each path, gather the LSP-symbol timelines whose latest version
 *      with `createdAt ≤ endedAt` is non-tombstoned. Collect those node ids.
 *   3. Patch the span's `touchedSymbols` field with those ids and bump its
 *      state `extracted → linked`.
 *
 * Run as an `onNodeState` job triggered on `Span:extracted`. The LSP job
 * inserts/bumps the symbols before this fires; even if a span is processed
 * before all symbols catch up, the next state-change re-run (or a fallback
 * timer) picks it up.
 */

import type { Db, DeepNode } from '@coffeectx/core';

const LSP_TYPES = [
  'LspModule', 'LspNamespace', 'LspClass',
  'LspMethod', 'LspConstructor', 'LspEnum', 'LspInterface', 'LspFunction',
];

export interface SpanLinkResult {
  scanned: number;
  linked: number;
  symbols: number;
  errors: Array<{ spanId: string; error: string }>;
}

export async function linkSpans(db: Db): Promise<SpanLinkResult> {
  const result: SpanLinkResult = { scanned: 0, linked: 0, symbols: 0, errors: [] };

  // 1. Index every LSP symbol by file_path, keeping its createdAt + timeline.
  //    For each timeline we'll later pick "latest version ≤ endedAt".
  const byFile = buildLspIndexByFile(db);

  // 2. Walk every Span in `extracted` state.
  for (const spanId of db.queryByNamedType(['Span'])) {
    if (db.getNodeState(spanId) !== 'extracted') continue;
    result.scanned += 1;
    try {
      const node = db.loadNodeDeep(spanId, 2);
      if (node.kind !== 'map') continue;
      const endedAt = parseNumeric(atomText(node.entries['endedAt']));
      if (endedAt == null) continue;
      const filesChanged = collectListAtoms(node.entries['filesChanged']);

      const symbolIds = new Set<string>();
      for (const relPath of filesChanged) {
        const symbols = byFile.get(relPath);
        if (!symbols) continue;
        // Group by timeline; pick the largest createdAt ≤ endedAt. The
        // tombstone flag here means "superseded later" — only treat it as
        // a real delete when the picked version is also the timeline head
        // (no newer version exists at all). Otherwise the version was alive
        // as-of endedAt and the tombstone is just bookkeeping from a later
        // bump landing post-hoc.
        const byTimeline = new Map<string, LspIndexed>();
        const headVersion = new Map<string, number>();
        for (const s of symbols) {
          const prevHead = headVersion.get(s.timelineId) ?? -Infinity;
          if (s.version > prevHead) headVersion.set(s.timelineId, s.version);
          if (s.createdAt == null || s.createdAt > endedAt) continue;
          const prev = byTimeline.get(s.timelineId);
          if (!prev || s.createdAt > (prev.createdAt ?? -Infinity)) byTimeline.set(s.timelineId, s);
        }
        for (const s of byTimeline.values()) {
          const isHead = s.version === headVersion.get(s.timelineId);
          if (s.tombstone && isHead) continue;  // true delete
          symbolIds.add(s.id);
        }
      }

      const refs = [...symbolIds].map(id => ({ $id: id }));
      await db.insertEntries([{
        id: spanId,
        type: 'Span',
        data: { touchedSymbols: refs },
      }]);
      db.setNodeState(spanId, 'linked');
      result.linked += 1;
      result.symbols += refs.length;
    } catch (err) {
      result.errors.push({ spanId, error: (err as Error).message });
    }
  }

  return result;
}

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
        const fp = readFilePath(db, row.id);
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

function readFilePath(db: Db, nodeId: string): string | null {
  const fid = db.getMapFieldId(nodeId, 'file_path');
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

function parseNumeric(s: string | null): number | null {
  if (s == null) return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}
