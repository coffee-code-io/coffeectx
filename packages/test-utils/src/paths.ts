/**
 * Path helpers for the replay harness. Every location is derived from
 * `~/.coffeecode/` (or `COFFEECODE_DIR` re-export from core).
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { COFFEECODE_DIR, DB_DIR } from '@coffeectx/core';

/** Where backups live. Sibling of `db/` and `snapshots/`. */
export const BACKUPS_DIR = join(COFFEECODE_DIR, 'backups');

/** Where chokidar snapshots live. Matches snapshotSupervisor.ts. */
export const SNAPSHOTS_DIR = join(COFFEECODE_DIR, 'snapshots');

/** Where the global file-hashes JSON lives. Matches indexer/src/fileHashes.ts. */
export const FILE_HASHES_PATH = join(COFFEECODE_DIR, 'file-hashes.json');

/** Root of Claude Code's per-cwd session JSONLs. */
export const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects');

export function projectDbPath(project: string): string {
  return join(DB_DIR, `${project}.db`);
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
