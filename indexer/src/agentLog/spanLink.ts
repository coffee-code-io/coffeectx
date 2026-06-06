/**
 * Span linker — LSP symbols + Plan instances.
 *
 * For each Span we walk twice:
 *   1. LSP — for each filesChanged entry, gather symbol-timeline versions
 *      whose `createdAt` falls in `(startedAt, effectiveEnd]` (a version
 *      born inside the span = the agent actually rewrote that symbol).
 *      Skip if the picked version is the timeline head AND tombstoned —
 *      that's a deletion-then-recreation we don't want to attach. Append
 *      ids into `touchedSymbols`.
 *   2. Plans — for each filesChanged entry, gather Plan nodes whose `path`
 *      matches and whose `createdAt` falls in `(startedAt, effectiveEnd]`
 *      (the plan was minted during this span). Append ids into
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

import type { Db, DeepNode, InsertEntry } from '@coffeectx/core';
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
      const symbolByType = needsSymbols
        ? gatherTouchedSymbols(filesChanged, startedAt, effectiveEnd, byFile, opts.repoPath)
        : new Map<string, string>();

      // ── Plans pass ──────────────────────────────────────────────────────
      const planIds = needsPlans
        ? gatherTouchedPlans(filesChanged, startedAt, effectiveEnd, plansByPath)
        : new Set<string>();

      // No-op early exit for already-`linked` spans with nothing to add.
      if (state === 'linked' && symbolByType.size === 0 && planIds.size === 0) continue;

      let symbolsAdded = 0;
      let plansAdded = 0;
      if (symbolByType.size > 0) {
        const listId = db.getMapFieldId(spanId, 'touchedSymbols');
        if (listId) symbolsAdded = db.appendListItemsUnique(listId, [...symbolByType.keys()]);
        else result.errors.push({ spanId, error: 'touchedSymbols field missing' });
        // Promote every attached LSP version `final → linked`. Best-effort —
        // a stuck row stays at `final` and the next repair pass will retry.
        for (const [id, typeName] of symbolByType) {
          try {
            await db.insertEntries([{ id, type: typeName, data: {}, state: 'linked' } as InsertEntry]);
          } catch (err) {
            result.errors.push({ spanId, error: `promote ${id}: ${(err as Error).message}` });
          }
        }
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
  typeName: string;
  timelineId: string;
  version: number;
  createdAt: number | null;
  tombstone: boolean;
}

function buildLspIndexByFile(db: Db): Map<string, LspIndexed[]> {
  const out = new Map<string, LspIndexed[]>();
  // queryByNamedType returns only non-tombstoned current versions, but for
  // `touchedSymbols` at a past time we need every version — walk all
  // timelines through listTimelineVersions instead. We also include
  // tombstones whose file_path can still be recovered from the prior
  // alive version: a tombstone version itself has no body, so we copy
  // file_path forward from the most recent alive version on the same
  // timeline.
  const seenTimeline = new Set<string>();
  const headIds = db.queryByNamedType(LSP_TYPES);
  for (const headId of headIds) {
    try {
      const meta = (db as unknown as {
        raw: { prepare: (sql: string) => { get: (...args: unknown[]) => unknown } };
      }).raw.prepare(`SELECT timeline_id, (SELECT name FROM named_types WHERE type_id=nodes.type_id) AS type_name FROM nodes WHERE id = ?`).get(headId) as
        | { timeline_id: string; type_name: string } | undefined;
      const timelineId = meta?.timeline_id;
      const typeName = meta?.type_name;
      if (!timelineId || !typeName || seenTimeline.has(timelineId)) continue;
      seenTimeline.add(timelineId);
      // Walk versions oldest → newest. file_path carries forward from
      // the most recent alive sibling so tombstone-bumps still bucket
      // under the right file.
      // Versions come oldest → newest. Read file_path directly when the
      // row has it (superseded-by-bump v_prev rows still carry the field
      // forward); fall back to the last-known alive sibling's file_path
      // for empty rows (deletion-bump tombstone versions have no body).
      let lastKnownFilePath: string | null = null;
      for (const row of db.listTimelineVersions(timelineId)) {
        if (row.state === 'new') continue;
        let fp = readMapSymbol(db, row.id, 'file_path');
        if (fp) lastKnownFilePath = fp;
        else fp = lastKnownFilePath;
        if (!fp) continue;
        const bucket = out.get(fp) ?? [];
        bucket.push({
          id: row.id,
          typeName,
          timelineId,
          version: row.version,
          createdAt: row.createdAt,
          tombstone: row.tombstone,
        });
        out.set(fp, bucket);
      }
    } catch { /* best-effort */ }
  }
  // queryByNamedType excludes tombstone heads, so a fully-deleted
  // timeline (final version is tombstone) won't be discovered above.
  // Walk those explicitly by scanning timelines whose head is tombstoned.
  const tombstonedHeads = (db as unknown as {
    raw: { prepare: (sql: string) => { all: (...args: unknown[]) => unknown[] } };
  }).raw.prepare(
    `SELECT n.id, n.timeline_id AS timelineId,
            (SELECT name FROM named_types WHERE type_id=n.type_id) AS typeName
       FROM nodes n
       JOIN named_types nt ON nt.type_id = n.type_id
      WHERE nt.name IN (${LSP_TYPES.map(() => '?').join(',')})
        AND n.tombstone = 1
        AND n.version = (SELECT MAX(version) FROM nodes WHERE timeline_id = n.timeline_id)`,
  ).all(...LSP_TYPES) as Array<{ id: string; timelineId: string; typeName: string }>;
  for (const head of tombstonedHeads) {
    if (seenTimeline.has(head.timelineId)) continue;
    seenTimeline.add(head.timelineId);
    let lastKnownFilePath: string | null = null;
    for (const row of db.listTimelineVersions(head.timelineId)) {
      if (row.state === 'new') continue;
      let fp = readMapSymbol(db, row.id, 'file_path');
      if (fp) lastKnownFilePath = fp;
      else fp = lastKnownFilePath;
      if (!fp) continue;
      const bucket = out.get(fp) ?? [];
      bucket.push({
        id: row.id,
        typeName: head.typeName,
        timelineId: head.timelineId,
        version: row.version,
        createdAt: row.createdAt,
        tombstone: row.tombstone,
      });
      out.set(fp, bucket);
    }
  }
  return out;
}

function gatherTouchedSymbols(
  filesChanged: string[],
  startedAt: number | null,
  cutoff: number,
  byFile: Map<string, LspIndexed[]>,
  repoPath: string | undefined,
): Map<string, string> {
  // id → typeName so the caller can promote each attached version
  // `final → linked` without a second DB round-trip per id.
  const out = new Map<string, string>();
  for (const rawPath of filesChanged) {
    // Historical spans stored absolute paths in `filesChanged` before the
    // indexer started relativizing them. Strip the repo prefix at lookup
    // time so the existing rows still match LSP file_path (always
    // repo-relative). New spans arrive already relativized.
    const relPath = relativizeForLookup(rawPath, repoPath);
    const symbols = byFile.get(relPath);
    if (!symbols) continue;
    // Per timeline: pick the largest createdAt in (startedAt, cutoff]. A
    // version born inside this window means the agent rewrote that symbol
    // during the span. Versions outside the window — older or newer — mean
    // the symbol existed in the file but wasn't touched here; we drop them
    // so a span doesn't pick up every neighbor symbol in a file it edited.
    const byTimeline = new Map<string, LspIndexed>();
    const headVersion = new Map<string, number>();
    for (const s of symbols) {
      const prevHead = headVersion.get(s.timelineId) ?? -Infinity;
      if (s.version > prevHead) headVersion.set(s.timelineId, s.version);
      if (s.createdAt == null) continue;
      if (s.createdAt > cutoff) continue;
      if (startedAt != null && s.createdAt <= startedAt) continue;
      const prev = byTimeline.get(s.timelineId);
      if (!prev || s.createdAt > (prev.createdAt ?? -Infinity)) byTimeline.set(s.timelineId, s);
    }
    for (const s of byTimeline.values()) {
      // Include tombstone heads — a tombstone-version born inside the
      // span window IS the deletion event the diff agent wants to see.
      // Downstream consumers check `nodes.tombstone` and render
      // deletions distinctly.
      out.set(s.id, s.typeName);
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
