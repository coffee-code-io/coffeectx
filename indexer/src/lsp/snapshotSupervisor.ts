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
  utimesSync,
  writeFileSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join, relative, sep } from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import { CLAUDE_DIR, COFFEECODE_DIR, type CoffeectxConfig } from '@coffeectx/core';

const SNAPSHOT_ROOT = join(COFFEECODE_DIR, 'snapshots');

export const SOURCE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'mjs', 'cjs', 'jsx',
  'py', 'rs', 'go', 'java', 'cs', 'cpp', 'cc', 'c', 'rb',
]);

/** Extensions watched when a `WatchSpec` targets the plans directory. */
export const PLANS_EXTENSIONS = new Set(['md']);

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '__pycache__', 'target',
]);

/**
 * Per-root watch configuration. The supervisor can watch any number of roots
 * in parallel, each with its own extension allowlist and dot-segment policy
 * (needed for `~/.claude/plans` which lives under a dotted directory the
 * default code-watch policy would skip).
 */
export interface WatchSpec {
  rootPath: string;
  extensions: Set<string>;
  /** When true, the default "skip path-segments starting with `.`" rule is
   *  disabled for THIS root. Required for `~/.claude/plans` and other
   *  dotted-prefix locations. Does NOT disable extension or `SKIP_DIRS`
   *  filtering. */
  allowDottedSegments?: boolean;
}

export interface SnapshotEntry {
  relPath: string;
  ts: number;
  snapshotPath: string;
  /** Source file mtime at copy time. Closer to "when the writer touched the
   *  file" than `ts` (which is supervisor wall-clock at scan moment); used
   *  by indexers that need write-time semantics (e.g. plans). */
  mtimeMs: number;
}

interface IndexRow extends SnapshotEntry {
  /** Absolute repoPath the snapshot belongs to. Lets one project watch
   *  multiple repos and still share a single index.jsonl. */
  repoPath: string;
  /** Source file size at copy time. Used together with `mtimeMs` to skip
   *  the next daemon-start `add` when neither has changed. */
  size: number;
}

export class SnapshotSupervisor {
  private readonly projectName: string;
  private readonly watches: WatchSpec[];
  private readonly watchers: FSWatcher[] = [];
  private readonly projectDir: string;
  private readonly indexPath: string;
  /** Latest snapshot per (rootPath, relPath). Seeded from index.jsonl on
   *  start(), updated in place on every new copy. Drives the stat-skip
   *  check: if an incoming `add` event's (size, mtimeMs) matches the
   *  latest entry's, the file hasn't changed since we last snapshotted
   *  it and we skip the copy. */
  private readonly latest = new Map<string, IndexRow>();

  constructor(opts: { projectName: string; watches: WatchSpec[] }) {
    this.projectName = opts.projectName;
    this.watches = opts.watches.map(w => ({
      ...w,
      rootPath: w.rootPath.replace(/\/+$/, ''),
    }));
    this.projectDir = join(SNAPSHOT_ROOT, sanitize(opts.projectName));
    this.indexPath = join(this.projectDir, 'index.jsonl');
  }

  async start(): Promise<void> {
    if (this.watches.length === 0) return;
    mkdirSync(this.projectDir, { recursive: true });
    this.seedLatestCache();
    const settled: Promise<void>[] = [];
    for (const spec of this.watches) {
      const rootPath = spec.rootPath;
      if (!existsSync(rootPath)) {
        console.warn(`[snapshot-supervisor] rootPath not found, skipping: ${rootPath}`);
        continue;
      }
      const extraSkip = loadCoffeeignore(rootPath);
      // ignoreInitial=false → chokidar emits 'add' for every existing source
      // file during its initial scan. Combined with the stat-skip check in
      // onChange, that means daemon restarts only re-snapshot files whose
      // (size, mtimeMs) differ from the prior snapshot — files unchanged
      // while the daemon was down don't get copied again.
      //
      // alwaysStat=true forces chokidar to deliver fs.Stats with every
      // add/change event so the skip check is a cheap integer compare,
      // no extra statSync round-trip.
      const watcher = chokidar.watch(rootPath, {
        ignored: (path, stats) => shouldIgnore(spec, path, stats, extraSkip),
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
        try { await this.onChange(spec, filePath, stats, /* allowSkip */ true); }
        finally { pending -= 1; checkSettled(); }
      });
      watcher.on('change', (filePath, stats) => {
        void this.onChange(spec, filePath, stats, /* allowSkip */ false);
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
      arr.push({ relPath: row.relPath, ts: row.ts, snapshotPath: row.snapshotPath, mtimeMs: row.mtimeMs });
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
    spec: WatchSpec,
    filePath: string,
    stats: Stats | undefined,
    allowSkip: boolean,
  ): void {
    const ext = extname(filePath).replace(/^\./, '');
    if (!spec.extensions.has(ext)) return;
    try {
      const relPath = relative(spec.rootPath, filePath);
      if (!relPath || relPath.startsWith('..')) return;
      const normRoot = spec.rootPath.replace(/\/+$/, '');

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
        const prior = this.latest.get(latestKey(normRoot, relPath));
        if (prior && prior.size === size && prior.mtimeMs === mtimeMs) return;
      }

      const ts = Date.now();
      const bucket = createHash('sha256').update(relPath).digest('hex').slice(0, 16);
      const dir = join(this.projectDir, bucket);
      mkdirSync(dir, { recursive: true });
      const snapshotPath = join(dir, `${ts}.${ext}`);
      copyFileSync(filePath, snapshotPath);
      // Mirror the source mtime onto the snapshot file so a plain `stat` of
      // the snapshot reflects when the writer actually touched the source —
      // not the wall-clock moment we happened to copy it. JSONL's `mtimeMs`
      // stays the canonical store; this is for tools that read snapshots
      // through the filesystem rather than the index.
      if (mtimeMs > 0) {
        try {
          const secs = mtimeMs / 1000;
          utimesSync(snapshotPath, secs, secs);
        } catch { /* non-fatal */ }
      }
      const row: IndexRow = { repoPath: normRoot, relPath, ts, snapshotPath, size, mtimeMs };
      appendFileSync(this.indexPath, JSON.stringify(row) + '\n');
      this.latest.set(latestKey(normRoot, relPath), row);
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
  spec: WatchSpec,
  path: string,
  stats: ReturnType<typeof statSync> | undefined,
  extraSkip: Set<string>,
): boolean {
  // chokidar may call the filter before stats are ready; in that case use the
  // path-segment heuristic and let chokidar resolve directories below.
  if (path === spec.rootPath) return false;
  const rel = relative(spec.rootPath, path);
  if (!rel) return false;
  for (const seg of rel.split(sep)) {
    if (!seg) continue;
    if (seg.startsWith('.') && !spec.allowDottedSegments) return true;
    if (SKIP_DIRS.has(seg)) return true;
    if (extraSkip.has(seg)) return true;
  }
  if (stats?.isDirectory()) return false;
  if (stats?.isFile()) {
    const ext = extname(path).replace(/^\./, '');
    return !spec.extensions.has(ext);
  }
  return false;
}

/** Delete the project's snapshot dir entirely — used by tests / forced resets. */
export function purgeSnapshots(projectName: string): void {
  const dir = join(SNAPSHOT_ROOT, sanitize(projectName));
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

/**
 * Resolve the set of watch roots a project should snapshot. Used by both the
 * scheduler at daemon-start AND init's first-snapshot pass so the two stay
 * in lockstep — no surprise "init snapshotted the whole monorepo, then the
 * daemon happily incremented from a much narrower root".
 *
 *   - One source-code root per enabled `lsp[:*]` job, taken from that job's
 *     `parameters.repoPath` (falling back to the project-level `repoPath`
 *     only when the job has none set). Deduped — multiple lsp:* jobs
 *     pointing at the same dir contribute one watch root.
 *   - The Claude plans dir, when `plans-claude` is enabled.
 *
 * The project-level `repoPath` is NEVER added directly — only through an
 * lsp-job fallback. A project that has no enabled lsp jobs (e.g. lsp is off
 * because the user hasn't picked a language server yet) won't watch the
 * whole repo root, which on a monorepo is the difference between "boots
 * fine" and "chokidar runs out of OS watcher slots".
 */
export function resolveWatchSpecs(
  config: CoffeectxConfig,
  projectName: string,
  fallbackRepoPath: string | undefined,
  jobNames: Iterable<string>,
): WatchSpec[] {
  const projectJobs = config.projects[projectName]?.jobs ?? {};
  const watches: WatchSpec[] = [];
  const seenCodeRoots = new Set<string>();
  for (const jobName of jobNames) {
    if (jobName !== 'lsp' && !jobName.startsWith('lsp:')) continue;
    const cfg = projectJobs[jobName];
    if (!cfg?.enabled) continue;
    const params = cfg.parameters ?? {};
    const raw = typeof params['repoPath'] === 'string' ? (params['repoPath'] as string) : undefined;
    const repoPath = raw ? expandTilde(raw) : fallbackRepoPath;
    if (repoPath && !seenCodeRoots.has(repoPath)) {
      seenCodeRoots.add(repoPath);
      watches.push({ rootPath: repoPath, extensions: SOURCE_EXTENSIONS });
    }
  }
  const plansCfg = projectJobs['plans-claude'];
  if (plansCfg?.enabled) {
    const raw = typeof plansCfg.parameters?.['plansDir'] === 'string'
      ? (plansCfg.parameters['plansDir'] as string) : undefined;
    const plansDir = raw ? expandTilde(raw) : join(CLAUDE_DIR, 'plans');
    watches.push({
      rootPath: plansDir,
      extensions: PLANS_EXTENSIONS,
      allowDottedSegments: true,
    });
  }
  return watches;
}

function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

/**
 * One-shot snapshot pass for `coffeectx init`: start a supervisor over the
 * project's resolved watch roots (lsp jobs' repoPaths + plans dir when
 * enabled), await its initial-scan settle, stop it. The supervisor's
 * stat-skip + `index.jsonl` semantics mean a subsequent daemon start sees
 * the work already done and won't re-copy unchanged files.
 *
 * Mirrors `resolveWatchSpecs` exactly — must, since the daemon picks up
 * from where init leaves off and a mismatch would re-snapshot bytes from
 * any path covered by one but not the other.
 *
 * No-op when there are no roots to snapshot (e.g. lsp jobs all disabled
 * and plans-claude off — nothing to bootstrap).
 */
export async function runFirstSnapshot(
  projectName: string,
  watches: WatchSpec[],
): Promise<void> {
  const live = watches.filter(w => existsSync(w.rootPath));
  if (live.length === 0) return;
  const sup = new SnapshotSupervisor({ projectName, watches: live });
  try { await sup.start(); }
  finally { await sup.stop(); }
}
