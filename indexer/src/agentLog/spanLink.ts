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

export async function linkSpans(db: Db, opts: { repoPath?: string } = {}): Promise<SpanLinkResult> {
  const result: SpanLinkResult = { scanned: 0, linked: 0, symbols: 0, errors: [] };

  // 1. Index every LSP symbol by file_path, keeping its createdAt + timeline.
  //    For each timeline we'll later pick "latest version ≤ endedAt".
  const byFile = buildLspIndexByFile(db);

  // 2. Walk every Span. `extracted` spans always get linked + bumped to
  //    `linked`. Already-`linked` spans get re-linked only when their
  //    current `touchedSymbols` is empty — this is the recovery path for
  //    historical spans that were "linked" with [] back when filesChanged
  //    used absolute paths and never matched LSP file_path.
  for (const spanId of db.queryByNamedType(['Span'])) {
    const state = db.getNodeState(spanId);
    if (state !== 'extracted' && state !== 'linked') continue;
    result.scanned += 1;
    try {
      const node = db.loadNodeDeep(spanId, 2);
      if (node.kind !== 'map') continue;
      const endedAt = parseNumeric(atomText(node.entries['endedAt']));
      if (endedAt == null) continue;
      const filesChanged = collectListAtoms(node.entries['filesChanged']);
      const existingCount = countListItems(node.entries['touchedSymbols']);

      // Skip cheap if a previous pass already produced a non-empty link
      // (we don't re-shuffle once symbols are attached).
      if (state === 'linked' && existingCount > 0) continue;

      const symbolIds = new Set<string>();
      for (const rawPath of filesChanged) {
        // Historical spans stored absolute paths in `filesChanged` before
        // the indexer started relativizing them. Strip the repo prefix at
        // lookup time so the existing rows still match LSP file_path
        // (always repo-relative). New spans arrive already relativized.
        const relPath = relativizeForLookup(rawPath, opts.repoPath);
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

      // Don't bother touching DB if nothing would change. For `extracted`
      // spans we still want the state bump so future passes skip them.
      if (symbolIds.size === 0 && state === 'linked') continue;

      // The Span node always has a `touchedSymbols` list (created at insert
      // time as `[]`). We append into that list directly — `insertEntries`'
      // plain-patch path is purely additive on missing keys, so it can't be
      // used to populate a field that's already initialized to an empty list.
      const listId = db.getMapFieldId(spanId, 'touchedSymbols');
      if (!listId) {
        result.errors.push({ spanId, error: 'touchedSymbols field missing' });
        continue;
      }
      const added = symbolIds.size > 0
        ? db.appendListItemsUnique(listId, [...symbolIds])
        : 0;
      if (state === 'extracted') db.setNodeState(spanId, 'linked');
      result.linked += 1;
      result.symbols += added;
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
