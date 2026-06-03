/**
 * Path helpers for the replay harness. Every location is derived from
 * `~/.coffeecode/` (or `COFFEECODE_DIR` re-export from core).
 */

import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { COFFEECODE_DIR, DB_DIR, loadConfig } from '@coffeectx/core';

/** Where backups live. Sibling of `db/` and `snapshots/`. */
export const BACKUPS_DIR = join(COFFEECODE_DIR, 'backups');

/** Where chokidar snapshots live. Matches snapshotSupervisor.ts. */
export const SNAPSHOTS_DIR = join(COFFEECODE_DIR, 'snapshots');

/** Where the global file-hashes JSON lives. Matches indexer/src/fileHashes.ts. */
export const FILE_HASHES_PATH = join(COFFEECODE_DIR, 'file-hashes.json');

/** Root of Claude Code's per-cwd session JSONLs. */
export const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects');

/**
 * Resolve the live DB path for a project. Honors `projects.<name>.db` in
 * `~/.coffeecode/config.yaml` when present — the project key in config can
 * differ from the DB file basename, so falling back blindly to
 * `${DB_DIR}/${project}.db` would target the wrong file. Falls back to that
 * convention only when the project is unregistered (e.g. ad-hoc harness
 * runs against a fresh restore).
 */
export function projectDbPath(project: string): string {
  try {
    const cfg = loadConfig();
    const entry = cfg.projects[project];
    if (entry?.db) return entry.db;
  } catch { /* config missing/unreadable — fall through to convention */ }
  return join(DB_DIR, `${project}.db`);
}

/**
 * Sibling files of a SQLite DB path that need to travel together. In WAL
 * mode SQLite keeps `<db>-wal` and `<db>-shm` alongside the main file;
 * leaving them behind during backup/restore/reset causes silent rollback
 * to a stale state once SQLite re-opens the trio. Returns absolute paths
 * for every `<basename>*` file that currently exists in the same dir.
 */
export function dbAndSiblings(dbPath: string): string[] {
  const dir = dirname(dbPath);
  const base = basename(dbPath);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(name => name === base || name.startsWith(base))
    .map(name => join(dir, name));
}

export function projectSnapshotDir(project: string): string {
  return join(SNAPSHOTS_DIR, sanitize(project));
}

export function backupDir(name: string): string {
  return join(BACKUPS_DIR, sanitize(name));
}

/**
 * Encode an absolute repo path into Claude Code's directory naming —
 * each `/` becomes `-`. Matches the encoding the user sets in
 * `config.projects[<p>].jobs.claude.parameters.path`.
 */
export function encodeClaudeProjectDir(repoPath: string): string {
  return repoPath.replace(/\//g, '-');
}

/** ~/.claude/projects/<encoded-cwd>/ — the directory holding session JSONLs. */
export function claudeLogsDirFor(repoPath: string): string {
  return join(CLAUDE_PROJECTS_DIR, encodeClaudeProjectDir(repoPath));
}

/** Layout under a backup directory. */
export function backupSnapshotsDir(backupName: string): string {
  return join(backupDir(backupName), 'snapshots');
}
export function backupDbPath(backupName: string, project: string): string {
  return join(backupDir(backupName), 'db', `${project}.db`);
}
export function backupHashesPath(backupName: string): string {
  return join(backupDir(backupName), 'file-hashes.json');
}
export function backupClaudeLogsDir(backupName: string): string {
  return join(backupDir(backupName), 'claude-logs');
}
export function backupManifestPath(backupName: string): string {
  return join(backupDir(backupName), 'manifest.json');
}

function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9_.-]+/g, '_');
}
