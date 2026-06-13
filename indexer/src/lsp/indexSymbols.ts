/**
 * LSP-driven symbol indexer.
 *
 * Flow on each run:
 *   1. Drain the snapshot supervisor (or, on a fresh DB, walk the repo).
 *   2. For each (relPath → list of timestamped snapshots), pick the most
 *      recent snapshot whose contents parse successfully via the LSP server.
 *   3. Extract surviving symbol kinds:
 *        - leaves     : LspMethod / LspConstructor / LspFunction (carry `source`)
 *        - enum-like  : LspEnum / LspInterface (carry `members` string list)
 *        - containers : LspClass / LspModule / LspNamespace (carry `children` $id refs)
 *   4. Pass 1: upsert leaves + enum-likes. Reuse the existing timeline if the
 *      hash matches; bump the version if it differs; create a new timeline
 *      otherwise.
 *   5. Pass 2: upsert containers with `children` set to the leaf $ids from
 *      pass 1.
 *   6. Tombstone any existing symbol whose file_path was reindexed in this
 *      run but which has no matching extracted symbol.
 *   7. GC consumed snapshots, keeping only the latest per relPath.
 *
 * The job stores its `lastConsumedTs` in `jobs.state_json` so re-runs only
 * pick up changes since the previous successful drain. The reverse-link pass
 * (event → symbol) is gone — span-based linking owns that now.
 */

import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import type { Db, InsertEntry, DeepNode } from '@coffeectx/core';
import { LspClient, SymbolKind, type DocumentSymbol, type SymbolInformation } from './client.js';
import type { SnapshotSupervisor, SnapshotEntry } from './snapshotSupervisor.js';
import { Progress } from '../jobs/progress.js';

const LEAF_TYPES = new Set(['LspMethod', 'LspConstructor', 'LspFunction']);
const ENUM_LIKE_TYPES = new Set(['LspEnum', 'LspInterface']);
const CONTAINER_TYPES = new Set(['LspClass', 'LspModule', 'LspNamespace']);
const ALL_LSP_TYPES = [
  'LspModule', 'LspNamespace', 'LspClass',
  'LspMethod', 'LspConstructor', 'LspEnum', 'LspInterface', 'LspFunction',
];

export interface IndexResult {
  files: number;
  nodes: number;
  bumped: number;
  deleted: number;
  skipped: boolean;
  errors: Array<{ file: string; error: string }>;
}

export interface IndexWithLspOptions {
  /** Optional supervisor. When present, runs are driven by snapshot drain;
   *  when absent (e.g. first-run bootstrap), the repo is walked from disk. */
  supervisor?: SnapshotSupervisor;
  /** Watermark from job state — drain snapshots with ts > this. Required when
   *  supervisor is provided; ignored otherwise. */
  lastConsumedTs?: number;
  /** Upper bound on snapshot ts to consider — typically the most recent
   *  finalised `Span.endedAt`. Snapshots with `ts > cutoffMs` are deferred
   *  until a later span close pushes the cutoff forward. `undefined` means
   *  "no cutoff" (bootstrap / manual trigger). */
  cutoffMs?: number;
}

export interface IndexResultWithCursor extends IndexResult {
  /** The new high-water-mark to persist into job state, if a supervisor was used. */
  consumedTs?: number;
}

// ── LSP kind mapping ──────────────────────────────────────────────────────────

function kindToTypeName(kind: SymbolKind): string | null {
  switch (kind) {
    case SymbolKind.Module:        return 'LspModule';
    case SymbolKind.Namespace:     return 'LspNamespace';
    case SymbolKind.Class:         return 'LspClass';
    case SymbolKind.Method:        return 'LspMethod';
    case SymbolKind.Constructor:   return 'LspConstructor';
    case SymbolKind.Enum:          return 'LspEnum';
    case SymbolKind.Interface:     return 'LspInterface';
    case SymbolKind.Function:      return 'LspFunction';
    // SymbolKind.Property, Field, Variable, Constant, EnumMember,
    // TypeParameter are intentionally dropped — see code.yaml notes.
    default:                       return null;
  }
}

// ── Anonymous / synthetic name filtering ─────────────────────────────────────

const ANONYMOUS_NAME_RE = /^<[^>]*>$|^\(\)$|^$/;
const SYNTHETIC_CALLBACK_RE = /(?:\)|\s)callback$/i;

function isAnonymous(name: string): boolean {
  const t = name.trim();
  return ANONYMOUS_NAME_RE.test(t) || SYNTHETIC_CALLBACK_RE.test(t);
}

/** Kinds whose body contains noise we don't want to surface. */
const FUNCTION_LIKE_KINDS = new Set<SymbolKind>([
  SymbolKind.Function, SymbolKind.Method, SymbolKind.Constructor,
]);

// ── Symbol record + flattening ────────────────────────────────────────────────

interface SymbolRecord {
  typeName: string;
  name: string;
  containerName: string;
  detail: string;
  line: number;
  column: number;
  endLine: number;          // for source extraction
  /** Filled for LspEnum/LspInterface — direct children name strings. */
  members?: string[];
  /** Filled for LspClass/LspModule/LspNamespace — direct DocumentSymbol
   *  children. Resolved to $ids during pass 2. */
  rawChildren?: DocumentSymbol[];
  /** Filled for function-like types — sliced from the snapshot file. */
  source?: string;
}

function flattenDocumentSymbols(
  symbols: DocumentSymbol[],
  containerName: string,
  out: SymbolRecord[],
  insideFunction = false,
): void {
  for (const s of symbols) {
    const typeName = kindToTypeName(s.kind);
    // Drop anonymous symbols outright. Drop everything inside a function
    // body — locals, nested arrow functions, IIFE bodies — these add noise
    // without helping any query.
    if (typeName && !isAnonymous(s.name) && !insideFunction) {
      const record: SymbolRecord = {
        typeName,
        name: s.name,
        containerName,
        detail: s.detail ?? '',
        line: s.selectionRange.start.line,
        column: s.selectionRange.start.character,
        endLine: s.range.end.line,
      };
      if (ENUM_LIKE_TYPES.has(typeName) && s.children?.length) {
        record.members = collectChildNames(s.children);
      }
      if (CONTAINER_TYPES.has(typeName) && s.children?.length) {
        record.rawChildren = s.children;
      }
      out.push(record);
    }
    if (s.children?.length) {
      const childInside = insideFunction || FUNCTION_LIKE_KINDS.has(s.kind);
      flattenDocumentSymbols(s.children, s.name, out, childInside);
    }
  }
}

function collectChildNames(children: DocumentSymbol[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const c of children) {
    if (isAnonymous(c.name)) continue;
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    out.push(c.name);
  }
  return out;
}

function flattenSymbolInformation(symbols: SymbolInformation[], out: SymbolRecord[]): void {
  for (const s of symbols) {
    const typeName = kindToTypeName(s.kind);
    if (!typeName) continue;
    if (isAnonymous(s.name)) continue;
    out.push({
      typeName,
      name: s.name,
      containerName: s.containerName ?? '',
      detail: '',
      line: s.location.range.start.line,
      column: s.location.range.start.character,
      endLine: s.location.range.end.line,
    });
  }
}

function isDocumentSymbolArray(arr: unknown[]): arr is DocumentSymbol[] {
  return arr.length > 0 && 'selectionRange' in (arr[0] as object);
}

/** Slice the function-body source from the snapshot bytes. LSP ranges are
 *  0-indexed, so we keep lines [start..end] inclusive. */
function sliceSource(lines: string[], startLine: number, endLine: number): string {
  if (startLine < 0 || endLine < 0 || startLine >= lines.length) return '';
  return lines.slice(startLine, endLine + 1).join('\n');
}

// ── Existing-symbol index ────────────────────────────────────────────────────

interface ExistingSymbol {
  id: string;
  typeName: string;
  name: string;
  containerName: string;
  filePath: string;
  hash: string;
  /** State of the *current* head version on the timeline. `null` for legacy
   *  rows inserted before the state machine landed. The indexer treats
   *  `null` the same as `'final'` — sealed, must bump on change. */
  state: string | null;
  /** `createdAt` of the current head version, used to look up which span
   *  bracketed the version's birth and decide patch-overwrite vs bump. */
  createdAt: number | null;
}

interface ExistingIndex {
  /** Lookup by stable key — same key shape as freshExtractKey(). */
  byKey: Map<string, ExistingSymbol>;
  /** All existing symbols grouped by file_path; used for the delete pass. */
  byFile: Map<string, ExistingSymbol[]>;
}

interface SpanInterval {
  spanId: string;
  startedAt: number;
  effectiveEnd: number;
}

/** Sorted-by-startedAt finalised-span intervals. Used by the indexer to
 *  bracket a snapshot's `mtimeMs` against the span that contains it. */
interface IntervalIndex {
  intervals: SpanInterval[];
  /** Returns the spanId whose `(startedAt, effectiveEnd]` contains `ts`,
   *  or null when no finalised span brackets the moment. */
  lookup(ts: number): string | null;
}

function stableKey(typeName: string, filePath: string, name: string, containerName: string): string {
  return `${typeName} ${filePath} ${name} ${containerName}`;
}

/** Hash of the value-changing fields. Line/column changes alone don't bump. */
function hashRecord(rec: SymbolRecord, childrenIds?: string[]): string {
  const h = createHash('sha256');
  h.update(rec.typeName); h.update(' ');
  h.update(rec.detail); h.update(' ');
  if (LEAF_TYPES.has(rec.typeName)) {
    h.update(rec.source ?? ''); h.update(' ');
  } else if (ENUM_LIKE_TYPES.has(rec.typeName)) {
    h.update((rec.members ?? []).join(',')); h.update(' ');
  } else if (CONTAINER_TYPES.has(rec.typeName)) {
    const sorted = (childrenIds ?? []).slice().sort();
    h.update(sorted.join(',')); h.update(' ');
  }
  return h.digest('hex');
}

function hashStoredSymbol(node: DeepNode): string {
  if (node.kind !== 'map') return '';
  const detail = atomText(node.entries['detail']) ?? '';
  const typeName = node.typeName ?? '';
  const h = createHash('sha256');
  h.update(typeName); h.update(' ');
  h.update(detail); h.update(' ');
  if (LEAF_TYPES.has(typeName)) {
    const source = atomText(node.entries['source']) ?? '';
    h.update(source); h.update(' ');
  } else if (ENUM_LIKE_TYPES.has(typeName)) {
    const members = extractListAtoms(node.entries['members']);
    h.update(members.join(',')); h.update(' ');
  } else if (CONTAINER_TYPES.has(typeName)) {
    const childIds = extractListIds(node.entries['children']).sort();
    h.update(childIds.join(',')); h.update(' ');
  }
  return h.digest('hex');
}

function atomText(n: DeepNode | undefined): string | null {
  if (!n || n.kind !== 'atom') return null;
  if (n.atom.kind === 'symbol') return n.atom.value;
  if (n.atom.kind === 'meaning') return n.atom.value.text;
  return null;
}

function extractListAtoms(n: DeepNode | undefined): string[] {
  if (!n || n.kind !== 'list') return [];
  const out: string[] = [];
  for (const item of n.items) {
    const t = atomText(item);
    if (t != null) out.push(t);
  }
  return out;
}

function extractListIds(n: DeepNode | undefined): string[] {
  if (!n || n.kind !== 'list') return [];
  const out: string[] = [];
  for (const item of n.items) {
    if (item.kind === 'ref') out.push(item.id);
    else if (item.kind === 'map' && item.id) out.push(item.id);
    else if (item.kind === 'cycle') out.push(item.id);
  }
  return out;
}

function buildExistingIndex(db: Db): ExistingIndex {
  const byKey = new Map<string, ExistingSymbol>();
  const byFile = new Map<string, ExistingSymbol[]>();
  const ids = db.queryByNamedType(ALL_LSP_TYPES);
  for (const id of ids) {
    try {
      const typeName = db.getNodeTypeName(id);
      if (!typeName) continue;
      const node = db.loadNodeDeep(id, 2);
      if (node.kind !== 'map') continue;
      const name = atomText(node.entries['name']) ?? '';
      const containerName = atomText(node.entries['containerName']) ?? '';
      const filePath = atomText(node.entries['file_path']) ?? '';
      if (!name || !filePath) continue;
      const hash = hashStoredSymbol(node);
      const state = db.getNodeState(id);
      const ts = db.getNodeTimestamps(id);
      const existing: ExistingSymbol = {
        id, typeName, name, containerName, filePath, hash,
        state, createdAt: ts?.createdAt ?? null,
      };
      byKey.set(stableKey(typeName, filePath, name, containerName), existing);
      const bucket = byFile.get(filePath) ?? [];
      bucket.push(existing);
      byFile.set(filePath, bucket);
    } catch { /* unloadable rows skipped */ }
  }
  return { byKey, byFile };
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function indexWithLsp(
  db: Db,
  repoPath: string,
  lspCommand: string,
  lspArgs: string[],
  options: IndexWithLspOptions = {},
): Promise<IndexResultWithCursor> {
  const result: IndexResultWithCursor = {
    files: 0, nodes: 0, bumped: 0, deleted: 0, skipped: false, errors: [],
  };

  const { supervisor, lastConsumedTs = 0, cutoffMs } = options;
  const existingIndex = buildExistingIndex(db);
  // Build (startedAt, effectiveEnd] interval map of finalised Spans. Used
  // to (a) gate which snapshots we even process — a snapshot whose
  // mtimeMs falls outside every finalised span is deferred until a span
  // closes around it — and (b) decide overwrite-in-place vs bump.
  const intervalIndex = buildSpanIntervalIndex(db);
  // Set of LSP node ids touched this run that are currently in state
  // `new`. Promoted to `final` at the end of the run.
  const newNodesThisRun = new Map<string, string>();   // id → typeName

  // Snapshot-only: LSP is a pure consumer of the supervisor's index. Init
  // and the daemon both populate snapshots; a missing supervisor here is a
  // misconfiguration (manual CLI smoke run with no supervisor wired up),
  // not something to paper over by reading the live repo.
  //
  // When `cutoffMs` is set we drop snapshots with `ts > cutoffMs` from each
  // file's candidate list. A file with NO snapshot ≤ cutoff is deferred:
  // its newer snapshots stay in the supervisor's index, untouched, until
  // the next span close pushes the cutoff forward.
  if (!supervisor) {
    result.skipped = true;
    return result;
  }
  const planned: Array<{ relPath: string; snapshots: SnapshotEntry[] }> = [];
  let maxTs = lastConsumedTs;
  const drained = supervisor.drainSince(repoPath, lastConsumedTs);
  for (const [relPath, entries] of drained) {
    const eligible = cutoffMs == null ? entries : entries.filter(e => e.ts <= cutoffMs);
    if (eligible.length === 0) continue;
    planned.push({ relPath, snapshots: eligible });
    for (const e of eligible) if (e.ts > maxTs) maxTs = e.ts;
  }
  if (planned.length === 0) {
    result.skipped = true;
    return result;
  }

  result.files = planned.length;

  const client = await LspClient.start(lspCommand, lspArgs, repoPath);
  await new Promise(r => setTimeout(r, 500));

  const progress = new Progress('lsp', planned.length);

  // Tracks which existing symbols were "covered" by extraction so the
  // delete pass knows which file paths' un-extracted leftovers to tombstone.
  const reindexedFiles = new Set<string>();

  try {
    for (let idx = 0; idx < planned.length; idx++) {
      const { relPath, snapshots } = planned[idx]!;
      progress.tick(idx, relPath);

      // `aliveAtCursor` carries forward across snapshots inside ONE file
      // so we can detect deletions: keys alive after snapshot N but
      // absent from snapshot N+1's records were removed by whatever
      // happened between them. Seeded from the existing-DB view of the
      // file so a deletion in the very first new snapshot is also
      // caught.
      const aliveAtCursor = new Set<string>();
      for (const sym of existingIndex.byFile.get(relPath) ?? []) {
        aliveAtCursor.add(stableKey(sym.typeName, relPath, sym.name, sym.containerName));
      }

      let appliedAny = false;
      for (let s = 0; s < snapshots.length; s++) {
        const entry = snapshots[s]!;
        // mtimeMs is when the writer (kernel) actually touched the file —
        // it's also the value the span linker matches against. Bracket
        // against finalised spans only; snapshots in an open/unindexed
        // window are deferred (no rows written this run).
        const snapshotTs = entry.mtimeMs || entry.ts;
        const bracketSpanId = intervalIndex.lookup(snapshotTs);
        if (bracketSpanId == null) continue;

        let rawSymbols: (DocumentSymbol | SymbolInformation)[] | null = null;
        let sourceLines: string[] | null = null;
        try {
          if (!existsSync(entry.snapshotPath)) continue;
          const sourceText = readFileSync(entry.snapshotPath, 'utf-8');
          rawSymbols = await client.documentSymbols(entry.snapshotPath);
          sourceLines = sourceText.split('\n');
        } catch {
          continue;
        }
        const records: SymbolRecord[] = [];
        if (isDocumentSymbolArray(rawSymbols!)) {
          flattenDocumentSymbols(rawSymbols as DocumentSymbol[], '', records);
        } else {
          flattenSymbolInformation(rawSymbols as SymbolInformation[], records);
        }
        for (const rec of records) {
          if (LEAF_TYPES.has(rec.typeName)) {
            rec.source = sliceSource(sourceLines!, rec.line, rec.endLine);
          }
        }
        reindexedFiles.add(relPath);
        await applyFileRecordsAtSnapshot(
          db, relPath, records,
          existingIndex, aliveAtCursor,
          bracketSpanId, intervalIndex,
          snapshotTs, newNodesThisRun, result,
        );
        appliedAny = true;
      }

      if (!appliedAny) {
        result.errors.push({ file: relPath, error: 'no snapshot in finalised span' });
        continue;
      }
    }
    progress.done(`${result.nodes} new, ${result.bumped} bumped, ${result.deleted} deleted`);
  } finally {
    await client.shutdown();
  }

  // Promote every `new` LSP row we touched this run → `final`. By
  // construction (§2 in the plan) every snapshot we processed was in a
  // finalised span, so `new` is purely transient — a crash-safety bit
  // we clear before the linker sees the rows.
  for (const [id, typeName] of newNodesThisRun) {
    try {
      const r = await db.insertEntries([{ id, type: typeName, data: {}, state: 'final' } as InsertEntry]);
      if (r.errors.length > 0) {
        pushErrors(result, '<promote>', r.errors);
      }
    } catch (err) {
      result.errors.push({ file: '<promote>', error: `promote ${id}: ${(err as Error).message}` });
    }
  }

  // Fallback: files we couldn't process any snapshot of (no eligible
  // bracket span found, parse errors on every snapshot). For those, the
  // per-snapshot delete tracking didn't run, so we still walk byFile and
  // tombstone everything. Uses delete+bumpVersion (the only deletion
  // model after the db.ts refactor).
  const fallbackFiles = new Set<string>();
  for (const { relPath } of planned) {
    if (!reindexedFiles.has(relPath)) fallbackFiles.add(relPath);
  }
  await tombstoneOrphans(db, fallbackFiles, existingIndex, result);

  if (supervisor) {
    result.consumedTs = maxTs;
    supervisor.gcKeepingLatest(repoPath);
  }

  return result;
}

function buildSpanIntervalIndex(db: Db): IntervalIndex {
  const intervals: SpanInterval[] = [];
  for (const spanId of db.queryByNamedType(['Span'])) {
    const startFid = db.getMapFieldId(spanId, 'startedAt');
    const endFid = db.getMapFieldId(spanId, 'effectiveEnd');
    if (!startFid || !endFid) continue;
    const startNode = db.loadNode(startFid);
    const endNode = db.loadNode(endFid);
    if (startNode.kind !== 'atom' || startNode.atom.kind !== 'symbol') continue;
    if (endNode.kind !== 'atom' || endNode.atom.kind !== 'symbol') continue;
    const startedAt = Number(startNode.atom.value);
    const effectiveEnd = Number(endNode.atom.value);
    if (!Number.isFinite(startedAt) || !Number.isFinite(effectiveEnd)) continue;
    intervals.push({ spanId, startedAt, effectiveEnd });
  }
  intervals.sort((a, b) => a.startedAt - b.startedAt);
  return {
    intervals,
    lookup(ts: number): string | null {
      // Linear scan — interval counts are O(spans-per-project). For the
      // sizes we see (hundreds) this is fine; if it ever needs to scale
      // swap in a binary search over the sorted-by-startedAt array.
      for (const iv of intervals) {
        if (ts > iv.startedAt && ts <= iv.effectiveEnd) return iv.spanId;
      }
      return null;
    },
  };
}

/**
 * Apply one snapshot's records against the running per-file state. Decides
 * per record whether to:
 *   - no-op (hash matches the existing alive head);
 *   - overwrite the head in place (existing is `new` AND lives in the same
 *     bracketing span as this snapshot — see types.ts InsertEntry.overwrite);
 *   - bump a new `new` version (existing is sealed `final`/`linked` OR was
 *     born in a different span);
 *   - create a fresh node (no prior entry — either truly new or post-
 *     resurrection where a previous tombstone broke continuity).
 * After records: any key in `aliveAtCursor` that's NOT in this snapshot's
 * records was deleted between snapshots — emit a delete+bumpVersion
 * tombstone with createdAt = snapshot mtime so the linker can attribute
 * it to the right span.
 *
 * `aliveAtCursor` is mutated to reflect the snapshot's view after return.
 * `newNodesThisRun` accumulates ids touched in state `new` for the final
 * promotion pass.
 */
async function applyFileRecordsAtSnapshot(
  db: Db,
  relPath: string,
  records: SymbolRecord[],
  existingIndex: ExistingIndex,
  aliveAtCursor: Set<string>,
  bracketSpanId: string,
  intervalIndex: IntervalIndex,
  snapshotTs: number,
  newNodesThisRun: Map<string, string>,
  result: IndexResult,
): Promise<void> {
  // Partition records — leaves/enum-likes first, containers second so
  // containers can resolve children by $id.
  const leaves: SymbolRecord[] = [];
  const containers: SymbolRecord[] = [];
  for (const r of records) {
    if (CONTAINER_TYPES.has(r.typeName)) containers.push(r);
    else leaves.push(r);
  }

  const idByLocalKey = new Map<string, string>();
  const seenKeys = new Set<string>();

  const applyOne = async (rec: SymbolRecord, recHash: string, data: Record<string, unknown>): Promise<void> => {
    const key = stableKey(rec.typeName, relPath, rec.name, rec.containerName);
    seenKeys.add(key);
    const existing = existingIndex.byKey.get(key);

    if (existing && existing.hash === recHash) {
      // No content change. Touch updated_at so debug UIs see the visit
      // and stamp createdAt forward if the existing head is `new` — the
      // version's "as-of" moment moves with the latest in-span snapshot.
      idByLocalKey.set(key, existing.id);
      if (existing.state === 'new' && intervalIndex.lookup(existing.createdAt ?? -1) === bracketSpanId) {
        try {
          await db.insertEntries([{
            id: existing.id, type: rec.typeName, data: {},
            updatedAt: snapshotTs,
          } as InsertEntry]);
          existing.createdAt = snapshotTs;
        } catch { /* no-op patch failures don't block the snapshot */ }
      }
      return;
    }

    if (!existing) {
      const r = await db.insertEntries([{ type: rec.typeName, data, createdAt: snapshotTs }]);
      pushErrors(result, relPath, r.errors);
      const newId = r.ids[0];
      if (newId) {
        idByLocalKey.set(key, newId);
        result.nodes += 1;
        newNodesThisRun.set(newId, rec.typeName);
        const fresh: ExistingSymbol = {
          id: newId, typeName: rec.typeName, name: rec.name,
          containerName: rec.containerName, filePath: relPath, hash: recHash,
          state: 'new', createdAt: snapshotTs,
        };
        existingIndex.byKey.set(key, fresh);
        const bucket = existingIndex.byFile.get(relPath) ?? [];
        bucket.push(fresh);
        existingIndex.byFile.set(relPath, bucket);
      }
      return;
    }

    // Existing head is alive but content differs. Overwrite if it's the
    // same span's `new` row, otherwise bump.
    const sameSpan = existing.state === 'new'
      && intervalIndex.lookup(existing.createdAt ?? -1) === bracketSpanId;
    if (sameSpan) {
      const r = await db.insertEntries([{
        id: existing.id, type: rec.typeName, data,
        overwrite: true, createdAt: snapshotTs, updatedAt: snapshotTs,
      } as InsertEntry]);
      pushErrors(result, relPath, r.errors);
      if (r.errors.length === 0) {
        idByLocalKey.set(key, existing.id);
        existing.hash = recHash;
        existing.createdAt = snapshotTs;
        newNodesThisRun.set(existing.id, rec.typeName);
      }
      return;
    }

    // Different span (or final/linked). Bump a fresh new-state version.
    // createdAt == updatedAt == source mtime so this version's lifetime
    // brackets the actual repo-file change, not when we got around to indexing.
    const r = await db.insertEntries([{
      id: existing.id, type: rec.typeName, data,
      bumpVersion: true, createdAt: snapshotTs, updatedAt: snapshotTs,
    } as InsertEntry]);
    pushErrors(result, relPath, r.errors);
    const newId = r.ids[0];
    if (newId) {
      idByLocalKey.set(key, newId);
      result.bumped += 1;
      newNodesThisRun.set(newId, rec.typeName);
      existing.id = newId;
      existing.hash = recHash;
      existing.state = 'new';
      existing.createdAt = snapshotTs;
    }
  };

  // Pass 1: leaves + enum-likes ───────────────────────────────────────────────
  for (const rec of leaves) {
    const recHash = hashRecord(rec);
    const data = buildEntryData(rec, relPath);
    await applyOne(rec, recHash, data);
  }

  // Pass 2: containers (with children $id refs resolved from pass 1) ────────
  for (const rec of containers) {
    const childIds: string[] = [];
    for (const child of rec.rawChildren ?? []) {
      const childTypeName = kindToTypeName(child.kind);
      if (!childTypeName || isAnonymous(child.name)) continue;
      const cKey = stableKey(childTypeName, relPath, child.name, rec.name);
      const cId = idByLocalKey.get(cKey);
      if (cId) childIds.push(cId);
    }
    const recHash = hashRecord(rec, childIds);
    const data = buildEntryData(rec, relPath);
    data['children'] = childIds.map(id => ({ $id: id }));
    await applyOne(rec, recHash, data);
  }

  // Per-snapshot deletion: keys alive going into this snapshot but absent
  // from its records were removed by whatever happened between snapshots.
  // Emit a delete+bumpVersion tombstone so the linker can attribute it.
  for (const key of aliveAtCursor) {
    if (seenKeys.has(key)) continue;
    const existing = existingIndex.byKey.get(key);
    if (!existing) continue;
    try {
      const r = await db.insertEntries([{
        id: existing.id, type: existing.typeName, data: {},
        delete: true, bumpVersion: true, createdAt: snapshotTs, updatedAt: snapshotTs,
      } as InsertEntry]);
      pushErrors(result, relPath, r.errors);
      const newId = r.ids[0];
      if (newId) {
        result.deleted += 1;
        newNodesThisRun.set(newId, existing.typeName);
        existing.id = newId;
        existing.state = 'new';
        existing.createdAt = snapshotTs;
        // Tombstone in DB; drop the byKey entry so a same-name resurrection
        // later starts a fresh timeline.
        existingIndex.byKey.delete(key);
      }
    } catch (err) {
      result.errors.push({ file: relPath, error: `tombstone ${existing.id}: ${(err as Error).message}` });
    }
  }

  // Refresh aliveAtCursor → exactly the keys present in this snapshot.
  aliveAtCursor.clear();
  for (const k of seenKeys) aliveAtCursor.add(k);
}

function buildEntryData(rec: SymbolRecord, relPath: string): Record<string, unknown> {
  // line + column intentionally omitted: position movement isn't a
  // structural change. The hash function excludes them too, so a function
  // shifted vertically (e.g. by a new function inserted above) does not
  // produce a fresh LSP version.
  const data: Record<string, unknown> = {
    name: rec.name,
    containerName: rec.containerName,
    detail: rec.detail,
    file_path: relPath,
  };
  if (LEAF_TYPES.has(rec.typeName)) {
    data['source'] = rec.source ?? '';
  } else if (ENUM_LIKE_TYPES.has(rec.typeName)) {
    data['members'] = rec.members ?? [];
  }
  return data;
}

function pushErrors(
  result: IndexResult,
  relPath: string,
  errors: Array<{ path: string; message: string }>,
): void {
  for (const e of errors) {
    result.errors.push({ file: relPath, error: `[${e.path}] ${e.message}` });
  }
}

/**
 * For every file we reindexed this run, tombstone any existing symbol that
 * survived `applyFileRecords` without being matched to a freshly-extracted
 * record. Deletes are issued as separate one-entry batches so a per-symbol
 * error doesn't take down the whole pass.
 */
async function tombstoneOrphans(
  db: Db,
  files: Set<string>,
  existingIndex: ExistingIndex,
  result: IndexResult,
): Promise<void> {
  const nowMs = Date.now();
  for (const relPath of files) {
    const orphans = existingIndex.byFile.get(relPath) ?? [];
    for (const orphan of orphans) {
      try {
        const r = await db.insertEntries([{
          id: orphan.id, type: orphan.typeName, data: {},
          delete: true, bumpVersion: true, createdAt: nowMs,
        } as InsertEntry]);
        pushErrors(result, relPath, r.errors);
        if (r.errors.length === 0) result.deleted += 1;
      } catch (err) {
        result.errors.push({ file: relPath, error: `delete ${orphan.id}: ${(err as Error).message}` });
      }
    }
  }
}
