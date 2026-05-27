/**
 * Side-process file watcher: copies bytes of every changed source file under a
 * watched repoPath into ~/.coffeecode/snapshots/<projectName>/<relPathSha>/<ts>.<ext>
 * and appends a row to <projectName>/index.jsonl.
 *
 * The LSP job drains the index, picks the most-recent snapshot per relPath that
 * parses, and after a successful run calls gcKeepingLatest() to drop everything
 * except the latest snapshot per path.
 *
 * Chokidar is used (not watchman) to keep the dep tree small and avoid an
 * external daemon. Survives indexer restarts because the JSONL on disk is the
 * source of truth — in-memory state isn't.
 */

import { createHash } from 'node:crypto';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { homedir } from 'node:os';
import chokidar, { type FSWatcher } from 'chokidar';

const SNAPSHOT_ROOT = join(homedir(), '.coffeecode', 'snapshots');

const SOURCE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'mjs', 'cjs', 'jsx',
  'py', 'rs', 'go', 'java', 'cs', 'cpp', 'cc', 'c', 'rb',
]);

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '__pycache__', 'target',
]);

export interface SnapshotEntry {
  relPath: string;
  ts: number;
  snapshotPath: string;
}

interface IndexRow extends SnapshotEntry {
  /** Absolute repoPath the snapshot belongs to. Lets one project watch
   *  multiple repos and still share a single index.jsonl. */
  repoPath: string;
  /** Source file size at copy time. Used together with `mtimeMs` to skip
   *  the next daemon-start `add` when neither has changed. */
  size: number;
  /** Source file mtime in ms at copy time. */
  mtimeMs: number;
}

export class SnapshotSupervisor {
  private readonly projectName: string;
  private readonly repoPaths: string[];
  private readonly watchers: FSWatcher[] = [];
  private readonly projectDir: string;
  private readonly indexPath: string;
  /** Latest snapshot per (repoPath, relPath). Seeded from index.jsonl on
   *  start(), updated in place on every new copy. Drives the stat-skip
   *  check: if an incoming `add` event's (size, mtimeMs) matches the
   *  latest entry's, the file hasn't changed since we last snapshotted
   *  it and we skip the copy. */
  private readonly latest = new Map<string, IndexRow>();

  constructor(opts: { projectName: string; repoPaths: string[] }) {
    this.projectName = opts.projectName;
    this.repoPaths = opts.repoPaths.map(p => p.replace(/\/+$/, ''));
    this.projectDir = join(SNAPSHOT_ROOT, sanitize(opts.projectName));
    this.indexPath = join(this.projectDir, 'index.jsonl');
  }

  async start(): Promise<void> {
    if (this.repoPaths.length === 0) return;
    mkdirSync(this.projectDir, { recursive: true });
    this.seedLatestCache();
    const settled: Promise<void>[] = [];
    for (const repoPath of this.repoPaths) {
      if (!existsSync(repoPath)) {
        console.warn(`[snapshot-supervisor] repoPath not found, skipping: ${repoPath}`);
        continue;
      }
      const extraSkip = loadCoffeeignore(repoPath);
      // ignoreInitial=false → chokidar emits 'add' for every existing source
      // file during its initial scan. Combined with the stat-skip check in
      // onChange, that means daemon restarts only re-snapshot files whose
      // (size, mtimeMs) differ from the prior snapshot — files unchanged
      // while the daemon was down don't get copied again.
      //
      // alwaysStat=true forces chokidar to deliver fs.Stats with every
      // add/change event so the skip check is a cheap integer compare,
      // no extra statSync round-trip.
      const watcher = chokidar.watch(repoPath, {
        ignored: (path, stats) => shouldIgnore(repoPath, path, stats, extraSkip),
        ignoreInitial: false,
        persistent: true,
        alwaysStat: true,
        awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 25 },
      });
      // Track in-flight add events triggered during the initial scan so
      // start() resolves only after they've all finished copying. Chokidar's
      // own 'ready' event fires when the directory walk completes, but
      // awaitWriteFinish-buffered 'add' events keep arriving after — we
      // wait for those too so the first LSP run sees a full snapshot index.
      let pending = 0;
      let scanComplete = false;
      let onSettled: (() => void) | null = null;
      const checkSettled = () => {
        if (scanComplete && pending === 0 && onSettled) {
          const fn = onSettled;
          onSettled = null;
          fn();
        }
      };
      watcher.on('add', async (filePath, stats) => {
        pending += 1;
        try { await this.onChange(repoPath, filePath, stats, /* allowSkip */ true); }
        finally { pending -= 1; checkSettled(); }
      });
      watcher.on('change', (filePath, stats) => {
        void this.onChange(repoPath, filePath, stats, /* allowSkip */ false);
      });
      watcher.once('ready', () => { scanComplete = true; checkSettled(); });
      settled.push(new Promise<void>(resolve => {
        onSettled = resolve;
        checkSettled();
      }));
      this.watchers.push(watcher);
    }
    await Promise.all(settled);
  }

  async stop(): Promise<void> {
    await Promise.all(this.watchers.map(w => w.close()));
    this.watchers.length = 0;
  }

  /** Read all index rows belonging to repoPath whose ts > since, grouped by relPath, ascending. */
  drainSince(repoPath: string, since: number): Map<string, SnapshotEntry[]> {
    const out = new Map<string, SnapshotEntry[]>();
    const normalized = repoPath.replace(/\/+$/, '');
    for (const row of this.readIndex()) {
      if (row.repoPath !== normalized) continue;
      if (row.ts <= since) continue;
      const arr = out.get(row.relPath) ?? [];
      arr.push({ relPath: row.relPath, ts: row.ts, snapshotPath: row.snapshotPath });
      out.set(row.relPath, arr);
    }
    for (const arr of out.values()) arr.sort((a, b) => a.ts - b.ts);
    return out;
  }

  /**
   * After a successful LSP run, for each relPath in repoPath keep only the
   * snapshot with the highest ts; delete files + rewrite the index for the
   * rest. Other repos' rows pass through untouched.
   */
  gcKeepingLatest(repoPath: string): void {
    const normalized = repoPath.replace(/\/+$/, '');
    const rows = this.readIndex();
    const latest = new Map<string, IndexRow>();
    const kept: IndexRow[] = [];
    const drop: IndexRow[] = [];
    for (const row of rows) {
      if (row.repoPath !== normalized) {
        kept.push(row);
        continue;
      }
      const prev = latest.get(row.relPath);
      if (!prev || row.ts > prev.ts) {
        if (prev) drop.push(prev);
        latest.set(row.relPath, row);
      } else {
        drop.push(row);
      }
    }
    for (const row of latest.values()) kept.push(row);
    for (const row of drop) {
      try { unlinkSync(row.snapshotPath); } catch { /* already gone */ }
    }
    this.writeIndex(kept);
    // Refresh the in-memory cache for this repo so the next add-skip check
    // sees the post-GC truth (which is just the still-present latest rows).
    for (const row of latest.values()) {
      this.latest.set(latestKey(row.repoPath, row.relPath), row);
    }
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private onChange(
    repoPath: string,
    filePath: string,
    stats: Stats | undefined,
    allowSkip: boolean,
  ): void {
    const ext = extname(filePath).replace(/^\./, '');
    if (!SOURCE_EXTENSIONS.has(ext)) return;
    try {
      const relPath = relative(repoPath, filePath);
      if (!relPath || relPath.startsWith('..')) return;
      const normRepo = repoPath.replace(/\/+$/, '');

      // alwaysStat=true should always give us Stats; if it didn't, fall
      // back to a sync stat so the skip check still works.
      const st = stats ?? safeStat(filePath);
      const size = st?.size ?? 0;
      const mtimeMs = Math.floor(st?.mtimeMs ?? 0);

      // Skip when the file is byte-for-byte the same as the last snapshot
      // we already have for it (same size, same mtime). Only applies to
      // `add` events — `change` always copies because something demonstrably
      // moved.
      if (allowSkip) {
        const prior = this.latest.get(latestKey(normRepo, relPath));
        if (prior && prior.size === size && prior.mtimeMs === mtimeMs) return;
      }

      const ts = Date.now();
      const bucket = createHash('sha256').update(relPath).digest('hex').slice(0, 16);
      const dir = join(this.projectDir, bucket);
      mkdirSync(dir, { recursive: true });
      const snapshotPath = join(dir, `${ts}.${ext}`);
      copyFileSync(filePath, snapshotPath);
      const row: IndexRow = { repoPath: normRepo, relPath, ts, snapshotPath, size, mtimeMs };
      appendFileSync(this.indexPath, JSON.stringify(row) + '\n');
      this.latest.set(latestKey(normRepo, relPath), row);
    } catch (err) {
      console.warn(`[snapshot-supervisor] copy failed for ${filePath}: ${(err as Error).message}`);
    }
  }

  /** Seed the per-(repo, relPath) latest cache from the existing index. */
  private seedLatestCache(): void {
    this.latest.clear();
    for (const row of this.readIndex()) {
      const key = latestKey(row.repoPath, row.relPath);
      const prev = this.latest.get(key);
      if (!prev || row.ts > prev.ts) this.latest.set(key, row);
    }
  }

  private readIndex(): IndexRow[] {
    if (!existsSync(this.indexPath)) return [];
    const out: IndexRow[] = [];
    for (const line of readFileSync(this.indexPath, 'utf-8').split('\n')) {
      if (!line) continue;
      try {
        const row = JSON.parse(line) as IndexRow;
        if (row && typeof row.relPath === 'string' && typeof row.ts === 'number') out.push(row);
      } catch { /* skip malformed lines */ }
    }
    return out;
  }

  private writeIndex(rows: IndexRow[]): void {
    const body = rows.map(r => JSON.stringify(r)).join('\n') + (rows.length > 0 ? '\n' : '');
    writeFileSync(this.indexPath, body);
  }
}

function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9_.-]+/g, '_');
}

function latestKey(repoPath: string, relPath: string): string {
  return `${repoPath} ${relPath}`;
}

function safeStat(filePath: string): Stats | null {
  try { return statSync(filePath); } catch { return null; }
}

function loadCoffeeignore(repoPath: string): Set<string> {
  const file = join(repoPath, '.coffeeignore');
  if (!existsSync(file)) return new Set();
  return new Set(
    readFileSync(file, 'utf-8')
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0 && !l.startsWith('#')),
  );
}

function shouldIgnore(
  repoPath: string,
  path: string,
  stats: ReturnType<typeof statSync> | undefined,
  extraSkip: Set<string>,
): boolean {
  // chokidar may call the filter before stats are ready; in that case use the
  // path-segment heuristic and let chokidar resolve directories below.
  if (path === repoPath) return false;
  const rel = relative(repoPath, path);
  if (!rel) return false;
  for (const seg of rel.split(sep)) {
    if (!seg) continue;
    if (seg.startsWith('.')) return true;
    if (SKIP_DIRS.has(seg)) return true;
    if (extraSkip.has(seg)) return true;
  }
  if (stats?.isDirectory()) return false;
  if (stats?.isFile()) {
    const ext = extname(path).replace(/^\./, '');
    return !SOURCE_EXTENSIONS.has(ext);
  }
  return false;
}

/** Delete the project's snapshot dir entirely — used by tests / forced resets. */
export function purgeSnapshots(projectName: string): void {
  const dir = join(SNAPSHOT_ROOT, sanitize(projectName));
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}
