/**
 * Snapshot every stateful surface for a project into a backup directory.
 *
 *   ~/.coffeecode/backups/<name>/
 *     snapshots/                   ← copy of ~/.coffeecode/snapshots/<project>/
 *     db/<project>.db              ← copy of the project DB
 *     file-hashes.json             ← entries scoped to this project only
 *     agent-logs/...               ← copy of the project's configured
 *                                    agent-log source (claude dir, codex
 *                                    sqlite, or pi sessions dir)
 *     manifest.json                ← summary + paths + counts + kind
 *
 * Idempotent in the sense that re-running with the same name overwrites.
 * Callers (CLI / tests) pass `name` if they want a stable handle; otherwise
 * we mint an ISO-8601 stamp.
 */

import {
  cpSync, existsSync, mkdirSync, readFileSync, readdirSync,
  statSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { loadConfig } from '@coffeectx/core';
import {
  BACKUPS_DIR, FILE_HASHES_PATH,
  backupAgentLogsDir, backupDbPath, backupDir, backupHashesPath,
  backupManifestPath, backupSnapshotsDir,
  dbAndSiblings, projectDbPath, projectSnapshotDir, resolveAgentLogJob,
  type AgentLogJob,
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

  const agentLog = resolveAgentLogJob(projectEntry);

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
  // Copy the main `.db` plus any `-wal` / `-shm` siblings SQLite is
  // currently using. Skipping them would let a restore silently roll back
  // to an older committed state once SQLite re-opens the trio.
  const liveDb = projectDbPath(opts.project);
  const dbBackup = backupDbPath(name, opts.project);
  const backupDbDir = dirname(dbBackup);
  const backupDbBase = basename(dbBackup);
  let dbBytes = 0;
  for (const liveFile of dbAndSiblings(liveDb)) {
    const suffix = basename(liveFile).slice(basename(liveDb).length); // '', '-wal', '-shm'
    const dest = join(backupDbDir, backupDbBase + suffix);
    cpSync(liveFile, dest);
    if (suffix === '') dbBytes = statSync(dest).size;
  }

  // ── File hashes (filtered to project) ─────────────────────────────────────
  const hashesPath = backupHashesPath(name);
  const projectHashes = filterHashesForProject(agentLog?.path, repoPath);
  writeFileSync(hashesPath, JSON.stringify(projectHashes, null, 2) + '\n');

  // ── Agent logs ────────────────────────────────────────────────────────────
  // Copy whatever the project's enabled provider points at: claude/pi → a
  // directory tree of `.jsonl` files; codex → a single sqlite file. cpSync
  // with {recursive:true} handles both. If no provider is configured (or
  // the source path doesn't exist), still create an empty backup dir so
  // restore is a clean no-op.
  const logsBackup = backupAgentLogsDir(name);
  mkdirSync(logsBackup, { recursive: true });
  let logSessions = 0;
  let logBytes = 0;
  let agentLogKind: 'claude' | 'codex' | 'pi' = 'claude';
  let agentLogPath = '';
  if (agentLog && existsSync(agentLog.path)) {
    agentLogKind = agentLog.kind;
    agentLogPath = agentLog.path;
    // For codex (single file), drop the bytes under `agent-logs/<basename>`
    // so restore can put them back the same way.
    const dest = isDirectory(agentLog.path) ? logsBackup : join(logsBackup, basename(agentLog.path));
    cpSync(agentLog.path, dest, { recursive: true });
    [logSessions, logBytes] = countAgentLog(logsBackup, agentLog.kind);
  } else if (agentLog) {
    agentLogKind = agentLog.kind;
    agentLogPath = agentLog.path;
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
      agentLogs: { kind: agentLogKind, path: agentLogPath, sessions: logSessions, totalBytes: logBytes },
    },
  };
  writeManifest(backupManifestPath(name), manifest);

  return { name, dir: bDir, manifest };
}

/**
 * Pull out the file-hashes entries that belong to this project — keys that
 * either start with the agent-log source path (per-session JSONL hashes for
 * claude/pi, or the codex sqlite path) or equal `lsp:<repoPath>` (LSP
 * manifest hash). When the project has no agent-log job configured, only
 * the LSP key is kept.
 */
function filterHashesForProject(agentLogPath: string | undefined, repoPath: string): Record<string, unknown> {
  if (!existsSync(FILE_HASHES_PATH)) return {};
  let all: Record<string, unknown>;
  try { all = JSON.parse(readFileSync(FILE_HASHES_PATH, 'utf-8')); }
  catch { return {}; }
  const lspKey = `lsp:${repoPath}`;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(all)) {
    if (k === lspKey) out[k] = v;
    else if (agentLogPath && k.startsWith(agentLogPath)) out[k] = v;
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

function countAgentLog(backupRoot: string, kind: AgentLogJob['kind']): [sessions: number, bytes: number] {
  // claude / pi back up a directory tree of `.jsonl` files; sessions = count
  // of `.jsonl` files anywhere under the backup root. codex backs up the
  // sqlite file itself — we can't trivially count threads without opening
  // it, so report 0 and let totalBytes describe the snapshot size.
  if (kind === 'codex') {
    const [, bytes] = countTree(backupRoot);
    return [0, bytes];
  }
  let sessions = 0;
  let bytes = 0;
  const walk = (p: string): void => {
    const st = statSync(p);
    if (st.isDirectory()) {
      for (const child of readdirSync(p)) walk(join(p, child));
    } else if (st.isFile()) {
      bytes += st.size;
      if (p.endsWith('.jsonl')) sessions += 1;
    }
  };
  if (existsSync(backupRoot)) walk(backupRoot);
  return [sessions, bytes];
}

function isDirectory(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}
