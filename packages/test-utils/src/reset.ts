/**
 * Wipe the project's stateful surfaces so a subsequent replay starts from
 * a known-clean slate. Leaves snapshots and claude logs alone — those are
 * the *inputs* to the pipeline, not state of the pipeline itself.
 *
 *   - DB file:        deleted (next `new Db()` recreates the schema)
 *   - File hashes:    project-scoped entries removed; other projects' entries kept
 *   - Snapshots:      see `resetSnapshots` (separate call — usually not wanted)
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { loadConfig } from '@coffeectx/core';
import { purgeSnapshots } from '@coffeectx/indexer/dist/lsp/snapshotSupervisor.js';
import { FILE_HASHES_PATH, claudeLogsDirFor, dbAndSiblings, projectDbPath } from './paths.js';

export function resetDb(project: string): void {
  // SQLite in WAL mode keeps `-wal` and `-shm` siblings; removing only the
  // main `.db` would leave them behind for the next `new Db()` to ingest
  // and silently roll the schema back to a stale state.
  for (const path of dbAndSiblings(projectDbPath(project))) {
    rmSync(path, { force: true });
  }
}

export function resetHashes(project: string): void {
  const config = loadConfig();
  const repoPath = config.projects[project]?.repoPath;
  if (!repoPath) return;
  if (!existsSync(FILE_HASHES_PATH)) return;
  const claudeLogsDir = readClaudeLogsPath(config.projects[project] ?? {}) ?? claudeLogsDirFor(repoPath);
  let all: Record<string, unknown>;
  try { all = JSON.parse(readFileSync(FILE_HASHES_PATH, 'utf-8')); }
  catch { return; }
  const lspKey = `lsp:${repoPath}`;
  const kept: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(all)) {
    if (k === lspKey) continue;
    if (k.startsWith(claudeLogsDir)) continue;
    kept[k] = v;
  }
  writeFileSync(FILE_HASHES_PATH, JSON.stringify(kept, null, 2) + '\n');
}

/** Wipe the chokidar snapshot store for this project. */
export function resetSnapshots(project: string): void {
  purgeSnapshots(project);
}

function readClaudeLogsPath(projectEntry: { jobs?: Record<string, { parameters?: Record<string, unknown> }> }): string | undefined {
  const params = projectEntry.jobs?.claude?.parameters;
  const path = params?.['path'];
  return typeof path === 'string' && path.length > 0 ? path : undefined;
}
