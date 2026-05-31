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
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Db, InsertEntry, DeepNode } from '@coffeectx/core';
import { LspClient, SymbolKind, type DocumentSymbol, type SymbolInformation } from './client.js';
import type { SnapshotSupervisor, SnapshotEntry } from './snapshotSupervisor.js';
import { Progress } from '../jobs/progress.js';

// Extensions the indexer will process (used only for the first-run disk walk).
const SOURCE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'mjs', 'cjs', 'jsx',
  'py', 'rs', 'go', 'java', 'cs', 'cpp', 'cc', 'c', 'rb',
]);

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '__pycache__', 'target',
]);

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
}

interface ExistingIndex {
  /** Lookup by stable key — same key shape as freshExtractKey(). */
  byKey: Map<string, ExistingSymbol>;
  /** All existing symbols grouped by file_path; used for the delete pass. */
  byFile: Map<string, ExistingSymbol[]>;
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
      const existing: ExistingSymbol = { id, typeName, name, containerName, filePath, hash };
      byKey.set(stableKey(typeName, filePath, name, containerName), existing);
      const bucket = byFile.get(filePath) ?? [];
      bucket.push(existing);
      byFile.set(filePath, bucket);
    } catch { /* unloadable rows skipped */ }
  }
  return { byKey, byFile };
}

// ── File selection ────────────────────────────────────────────────────────────

interface FileToIndex {
  relPath: string;
  /** Absolute path to the source bytes we'll feed to the LSP server. May be
   *  inside the repo (first-run walk) or under the snapshot store. */
  bytesPath: string;
  /** ts of the snapshot we ended up using; undefined when read from disk. */
  consumedTs?: number;
}

function loadCoffeeignore(rootPath: string): Set<string> {
  const ignorePath = join(rootPath, '.coffeeignore');
  if (!existsSync(ignorePath)) return new Set();
  return new Set(
    readFileSync(ignorePath, 'utf-8')
      .split('\n').map(l => l.trim()).filter(l => l.length > 0 && !l.startsWith('#')),
  );
}

function walkRepo(rootPath: string): string[] {
  const extraSkip = loadCoffeeignore(rootPath);
  const out: string[] = [];
  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !extraSkip.has(entry.name)) walk(full);
      } else if (entry.isFile()) {
        const ext = entry.name.split('.').pop() ?? '';
        if (SOURCE_EXTENSIONS.has(ext)) out.push(full);
      }
    }
  }
  walk(rootPath);
  return out;
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

  // Build the (relPath, snapshots) list. With a supervisor we drain its
  // index since the last consumed ts (the supervisor's initial scan
  // populates a snapshot per source file on daemon start, so even a
  // fresh DB has snapshots to consume). Without a supervisor — manual CLI
  // runs of indexWithLsp — we fall back to a direct disk walk.
  //
  // When `cutoffMs` is set we drop snapshots with `ts > cutoffMs` from each
  // file's candidate list. A file with NO snapshot ≤ cutoff is deferred:
  // its newer snapshots stay in the supervisor's index, untouched, until
  // the next span close pushes the cutoff forward.
  const planned: Array<{ relPath: string; snapshots: SnapshotEntry[] }> = [];
  let maxTs = lastConsumedTs;
  if (supervisor) {
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
  } else {
    for (const abs of walkRepo(repoPath)) {
      planned.push({ relPath: relative(repoPath, abs), snapshots: [{ relPath: relative(repoPath, abs), ts: 0, snapshotPath: abs }] });
    }
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

      // Pick the most-recent snapshot the LSP server can read. Snapshots
      // are ordered ascending; walk from newest to oldest. A zero-symbol
      // result is a valid parse — re-export-only `index.ts`, comment-only
      // headers, etc. all legitimately yield no DocumentSymbols. Only an
      // exception (thrown by `documentSymbols`) is treated as a failed
      // parse worth walking back from.
      let picked: { entry: SnapshotEntry; rawSymbols: (DocumentSymbol | SymbolInformation)[]; sourceLines: string[] } | null = null;
      for (let s = snapshots.length - 1; s >= 0; s--) {
        const entry = snapshots[s]!;
        try {
          if (!existsSync(entry.snapshotPath)) continue;
          const sourceText = readFileSync(entry.snapshotPath, 'utf-8');
          const rawSymbols = await client.documentSymbols(entry.snapshotPath);
          picked = { entry, rawSymbols, sourceLines: sourceText.split('\n') };
          break;
        } catch {
          // Try the next older snapshot.
        }
      }

      if (!picked) {
        result.errors.push({ file: relPath, error: 'no snapshot parsed' });
        continue;
      }

      const records: SymbolRecord[] = [];
      if (isDocumentSymbolArray(picked.rawSymbols)) {
        flattenDocumentSymbols(picked.rawSymbols as DocumentSymbol[], '', records);
      } else {
        flattenSymbolInformation(picked.rawSymbols as SymbolInformation[], records);
      }

      // Fill `source` for function-likes from the snapshot bytes.
      for (const rec of records) {
        if (LEAF_TYPES.has(rec.typeName)) {
          rec.source = sliceSource(picked.sourceLines, rec.line, rec.endLine);
        }
      }

      reindexedFiles.add(relPath);
      await applyFileRecords(db, relPath, records, existingIndex, result, picked.entry.ts);
    }
    progress.done(`${result.nodes} new, ${result.bumped} bumped, ${result.deleted} deleted`);
  } finally {
    await client.shutdown();
  }

  // Delete pass — anything in a reindexed file that wasn't covered by the
  // freshly-extracted records gets tombstoned. The covered set is tracked
  // inside applyFileRecords via existingIndex.byKey (matched entries are
  // removed from byFile during processing).
  await tombstoneOrphans(db, reindexedFiles, existingIndex, result);

  if (supervisor) {
    result.consumedTs = maxTs;
    supervisor.gcKeepingLatest(repoPath);
  }

  return result;
}

/**
 * Apply the extracted records for a single file. Mutates `existingIndex` so
 * the delete pass at the end only sees genuinely-orphaned rows.
 */
async function applyFileRecords(
  db: Db,
  relPath: string,
  records: SymbolRecord[],
  existingIndex: ExistingIndex,
  result: IndexResult,
  createdAt: number,
): Promise<void> {
  // Partition records — leaves/enum-likes first, containers second.
  const leaves: SymbolRecord[] = [];
  const containers: SymbolRecord[] = [];
  for (const r of records) {
    if (CONTAINER_TYPES.has(r.typeName)) containers.push(r);
    else leaves.push(r);
  }

  // Track key → resolved id for the in-batch lookup pass 2 needs.
  const idByLocalKey = new Map<string, string>();
  const remainingInFile = new Set((existingIndex.byFile.get(relPath) ?? []).map(s => s.id));

  // Pass 1: leaves + enum-likes ───────────────────────────────────────────────
  for (const rec of leaves) {
    const key = stableKey(rec.typeName, relPath, rec.name, rec.containerName);
    const existing = existingIndex.byKey.get(key);
    const recHash = hashRecord(rec);
    if (existing && existing.hash === recHash) {
      idByLocalKey.set(key, existing.id);
      remainingInFile.delete(existing.id);
      continue;
    }
    const data = buildEntryData(rec, relPath);
    if (existing) {
      // bump — same timeline, new version. `createdAt` is the picked
      // snapshot's ts so the version's "as of" time matches when that
      // source state existed on disk (drives span-link picking).
      const r = await db.insertEntries([{ id: existing.id, type: rec.typeName, data, bumpVersion: true, createdAt } as InsertEntry]);
      pushErrors(result, relPath, r.errors);
      const newId = r.ids[0];
      if (newId) {
        idByLocalKey.set(key, newId);
        result.bumped += 1;
        // Replace the index entry so subsequent re-runs in the same job
        // don't redundantly bump.
        existing.id = newId;
        existing.hash = recHash;
      }
      remainingInFile.delete(existing.id);
    } else {
      const r = await db.insertEntries([{ type: rec.typeName, data, createdAt }]);
      pushErrors(result, relPath, r.errors);
      const newId = r.ids[0];
      if (newId) {
        idByLocalKey.set(key, newId);
        result.nodes += 1;
        const fresh: ExistingSymbol = {
          id: newId, typeName: rec.typeName, name: rec.name,
          containerName: rec.containerName, filePath: relPath, hash: recHash,
        };
        existingIndex.byKey.set(key, fresh);
        const bucket = existingIndex.byFile.get(relPath) ?? [];
        bucket.push(fresh);
        existingIndex.byFile.set(relPath, bucket);
      }
    }
  }

  // Pass 2: containers (with children $id refs from pass 1) ──────────────────
  for (const rec of containers) {
    const childIds: string[] = [];
    for (const child of rec.rawChildren ?? []) {
      const childTypeName = kindToTypeName(child.kind);
      if (!childTypeName || isAnonymous(child.name)) continue;
      // Containers contain leaves, enum-likes, AND nested containers. Look up
      // any kind we know about.
      const cKey = stableKey(childTypeName, relPath, child.name, rec.name);
      const cId = idByLocalKey.get(cKey);
      if (cId) childIds.push(cId);
    }
    const key = stableKey(rec.typeName, relPath, rec.name, rec.containerName);
    const existing = existingIndex.byKey.get(key);
    const recHash = hashRecord(rec, childIds);
    if (existing && existing.hash === recHash) {
      idByLocalKey.set(key, existing.id);
      remainingInFile.delete(existing.id);
      continue;
    }
    const data = buildEntryData(rec, relPath);
    data['children'] = childIds.map(id => ({ $id: id }));
    if (existing) {
      const r = await db.insertEntries([{ id: existing.id, type: rec.typeName, data, bumpVersion: true, createdAt } as InsertEntry]);
      pushErrors(result, relPath, r.errors);
      const newId = r.ids[0];
      if (newId) {
        idByLocalKey.set(key, newId);
        result.bumped += 1;
        existing.id = newId;
        existing.hash = recHash;
      }
      remainingInFile.delete(existing.id);
    } else {
      const r = await db.insertEntries([{ type: rec.typeName, data, createdAt }]);
      pushErrors(result, relPath, r.errors);
      const newId = r.ids[0];
      if (newId) {
        idByLocalKey.set(key, newId);
        result.nodes += 1;
        const fresh: ExistingSymbol = {
          id: newId, typeName: rec.typeName, name: rec.name,
          containerName: rec.containerName, filePath: relPath, hash: recHash,
        };
        existingIndex.byKey.set(key, fresh);
        const bucket = existingIndex.byFile.get(relPath) ?? [];
        bucket.push(fresh);
        existingIndex.byFile.set(relPath, bucket);
      }
    }
  }

  // Mark the un-touched existing rows in this file for the delete pass.
  // They've stayed in `byFile`'s bucket; the post-pass tombstone walker
  // will check membership in `reindexedFiles` and tombstone them.
  if (remainingInFile.size > 0) {
    const bucket = existingIndex.byFile.get(relPath) ?? [];
    existingIndex.byFile.set(
      relPath,
      bucket.filter(s => remainingInFile.has(s.id)),
    );
  } else {
    existingIndex.byFile.set(relPath, []);
  }
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
  reindexedFiles: Set<string>,
  existingIndex: ExistingIndex,
  result: IndexResult,
): Promise<void> {
  for (const relPath of reindexedFiles) {
    const orphans = existingIndex.byFile.get(relPath) ?? [];
    for (const orphan of orphans) {
      try {
        const r = await db.insertEntries([{
          id: orphan.id, type: orphan.typeName, data: {}, delete: true,
        } as InsertEntry]);
        pushErrors(result, relPath, r.errors);
        if (r.errors.length === 0) result.deleted += 1;
      } catch (err) {
        result.errors.push({ file: relPath, error: `delete ${orphan.id}: ${(err as Error).message}` });
      }
    }
  }
}
