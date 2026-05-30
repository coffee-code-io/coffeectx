/**
 * Snapshot every stateful surface for a project into a backup directory.
 *
 *   ~/.coffeecode/backups/<name>/
 *     snapshots/                   ← copy of ~/.coffeecode/snapshots/<project>/
 *     db/<project>.db              ← copy of the project DB
 *     file-hashes.json             ← entries scoped to this project only
 *     claude-logs/<encoded>/       ← copy of ~/.claude/projects/<encoded>/
 *     manifest.json                ← summary + paths + counts
 *
 * Idempotent in the sense that re-running with the same name overwrites.
 * Callers (CLI / tests) pass `name` if they want a stable handle; otherwise
 * we mint an ISO-8601 stamp.
 */

import {
  cpSync, existsSync, mkdirSync, readFileSync, readdirSync,
  statSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '@coffeectx/core';
import {
  BACKUPS_DIR, FILE_HASHES_PATH,
  backupClaudeLogsDir, backupDbPath, backupDir, backupHashesPath,
  backupManifestPath, backupSnapshotsDir,
  claudeLogsDirFor, projectDbPath, projectSnapshotDir,
} from './paths.js';
import { writeManifest, type BackupManifest } from './manifest.js';

export interface BackupOptions {
  project: string;
  /** Optional handle; defaults to an ISO-8601 timestamp. */
  name?: string;
}

export interface BackupResult {
  name: string;
  dir: string;
  manifest: BackupManifest;
}

export function backup(opts: BackupOptions): BackupResult {
  const config = loadConfig();
  const projectEntry = config.projects[opts.project];
  if (!projectEntry) throw new Error(`unknown project: ${opts.project}`);

  const repoPath = projectEntry.repoPath;
  if (!repoPath) throw new Error(`project ${opts.project} has no repoPath set in config`);

  const claudeLogsLive = readClaudeLogsPath(projectEntry) ?? claudeLogsDirFor(repoPath);

  const name = opts.name ?? new Date().toISOString().replace(/[:.]/g, '-');
  const bDir = backupDir(name);
  mkdirSync(BACKUPS_DIR, { recursive: true });
  mkdirSync(bDir, { recursive: true });
  mkdirSync(join(bDir, 'db'), { recursive: true });

  // ── Snapshots ─────────────────────────────────────────────────────────────
  const liveSnapshots = projectSnapshotDir(opts.project);
  const snapshotsBackup = backupSnapshotsDir(name);
  let snapCount = 0;
  let snapBytes = 0;
  if (existsSync(liveSnapshots)) {
    cpSync(liveSnapshots, snapshotsBackup, { recursive: true });
    [snapCount, snapBytes] = countTree(snapshotsBackup);
  } else {
    mkdirSync(snapshotsBackup, { recursive: true });
  }

  // ── DB ────────────────────────────────────────────────────────────────────
  const liveDb = projectDbPath(opts.project);
  const dbBackup = backupDbPath(name, opts.project);
  let dbBytes = 0;
  if (existsSync(liveDb)) {
    cpSync(liveDb, dbBackup);
    dbBytes = statSync(dbBackup).size;
  }

  // ── File hashes (filtered to project) ─────────────────────────────────────
  const hashesPath = backupHashesPath(name);
  const projectHashes = filterHashesForProject(claudeLogsLive, repoPath);
  writeFileSync(hashesPath, JSON.stringify(projectHashes, null, 2) + '\n');

  // ── Claude logs ───────────────────────────────────────────────────────────
  const logsBackup = backupClaudeLogsDir(name);
  let logSessions = 0;
  let logBytes = 0;
  if (existsSync(claudeLogsLive)) {
    cpSync(claudeLogsLive, logsBackup, { recursive: true });
    const jsonls = readdirSync(logsBackup).filter(f => f.endsWith('.jsonl'));
    logSessions = jsonls.length;
    [, logBytes] = countTree(logsBackup);
  } else {
    mkdirSync(logsBackup, { recursive: true });
  }

  // ── Manifest ──────────────────────────────────────────────────────────────
  const manifest: BackupManifest = {
    project: opts.project,
    repoPath,
    recordedAt: new Date().toISOString(),
    sources: {
      snapshots: { path: liveSnapshots, count: snapCount, totalBytes: snapBytes },
      db:        { path: liveDb,        bytes: dbBytes },
      fileHashes:{ entryCount: Object.keys(projectHashes).length },
      claudeLogs:{ path: claudeLogsLive, sessions: logSessions, totalBytes: logBytes },
    },
  };
  writeManifest(backupManifestPath(name), manifest);

  return { name, dir: bDir, manifest };
}

/**
 * Pull out the file-hashes entries that belong to this project — keys that
 * either start with the claude-logs path (per-session JSONL hashes) or
 * equal `lsp:<repoPath>` (LSP manifest hash).
 */
function filterHashesForProject(claudeLogsDir: string, repoPath: string): Record<string, unknown> {
  if (!existsSync(FILE_HASHES_PATH)) return {};
  let all: Record<string, unknown>;
  try { all = JSON.parse(readFileSync(FILE_HASHES_PATH, 'utf-8')); }
  catch { return {}; }
  const lspKey = `lsp:${repoPath}`;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(all)) {
    if (k === lspKey) out[k] = v;
    else if (k.startsWith(claudeLogsDir)) out[k] = v;
  }
  return out;
}

function countTree(root: string): [count: number, bytes: number] {
  if (!existsSync(root)) return [0, 0];
  let count = 0;
  let bytes = 0;
  const walk = (p: string): void => {
    const st = statSync(p);
    if (st.isDirectory()) {
      for (const child of readdirSync(p)) walk(join(p, child));
    } else if (st.isFile()) {
      count += 1;
      bytes += st.size;
    }
  };
  walk(root);
  return [count, bytes];
}

function readClaudeLogsPath(projectEntry: { jobs?: Record<string, { parameters?: Record<string, unknown> }> }): string | undefined {
  const params = projectEntry.jobs?.claude?.parameters;
  const path = params?.['path'];
  return typeof path === 'string' && path.length > 0 ? path : undefined;
}
