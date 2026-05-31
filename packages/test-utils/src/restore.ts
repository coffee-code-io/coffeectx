/**
 * Restore a project to a captured backup state. Order matters:
 *   1. Wipe live DB, snapshot store, and project-scoped hashes.
 *   2. Copy backup snapshots, DB, and claude logs back into their live
 *      locations.
 *   3. Merge backup's filtered file-hashes into the live JSON.
 *
 * After restore, `run` (or the indexer daemon) can execute as if nothing
 * had happened — modulo the wall clock, which `run` controls via
 * `closeBeforeMs`.
 */

import {
  cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { loadConfig } from '@coffeectx/core';
import {
  FILE_HASHES_PATH,
  backupClaudeLogsDir, backupDbPath, backupHashesPath,
  backupManifestPath, backupSnapshotsDir,
  claudeLogsDirFor, dbAndSiblings, projectDbPath, projectSnapshotDir,
} from './paths.js';
import { readManifest, type BackupManifest } from './manifest.js';
import { resetDb, resetHashes, resetSnapshots } from './reset.js';

export interface RestoreOptions {
  project: string;
  name: string;
}

export function restore(opts: RestoreOptions): BackupManifest {
  const manifest = readManifest(backupManifestPath(opts.name));
  if (manifest.project !== opts.project) {
    throw new Error(
      `backup ${opts.name} was recorded for project "${manifest.project}", not "${opts.project}"`,
    );
  }
  const config = loadConfig();
  const projectEntry = config.projects[opts.project];
  if (!projectEntry) throw new Error(`unknown project: ${opts.project}`);

  const repoPath = projectEntry.repoPath ?? manifest.repoPath;
  const claudeLogsLive = readClaudeLogsPath(projectEntry) ?? claudeLogsDirFor(repoPath);

  // ── Wipe live state ──────────────────────────────────────────────────────
  resetDb(opts.project);
  resetSnapshots(opts.project);
  resetHashes(opts.project);

  // ── Restore snapshots ────────────────────────────────────────────────────
  const snapshotsBackup = backupSnapshotsDir(opts.name);
  const snapshotsLive = projectSnapshotDir(opts.project);
  if (existsSync(snapshotsBackup)) {
    cpSync(snapshotsBackup, snapshotsLive, { recursive: true });
  }

  // ── Restore DB ───────────────────────────────────────────────────────────
  // resetDb above already removed live `-wal` / `-shm` siblings. Now copy
  // back every `<project>.db*` file present in the backup so SQLite sees a
  // consistent trio. We can't just copy the main file: if a `-wal` from a
  // prior run is still there (resetDb missed it), SQLite would replay it
  // and corrupt the restored state.
  const dbBackup = backupDbPath(opts.name, opts.project);
  const dbLive = projectDbPath(opts.project);
  if (existsSync(dbBackup)) {
    mkdirSync(dirname(dbLive), { recursive: true });
    const liveDir = dirname(dbLive);
    const liveBase = basename(dbLive);
    for (const backupFile of dbAndSiblings(dbBackup)) {
      const suffix = basename(backupFile).slice(basename(dbBackup).length);
      cpSync(backupFile, join(liveDir, liveBase + suffix));
    }
  }

  // ── Merge backup hashes into live file-hashes.json ───────────────────────
  const hashesBackupPath = backupHashesPath(opts.name);
  if (existsSync(hashesBackupPath)) {
    const backupHashes = JSON.parse(readFileSync(hashesBackupPath, 'utf-8')) as Record<string, unknown>;
    let liveHashes: Record<string, unknown> = {};
    if (existsSync(FILE_HASHES_PATH)) {
      try { liveHashes = JSON.parse(readFileSync(FILE_HASHES_PATH, 'utf-8')); }
      catch { /* fall through with empty */ }
    }
    const merged = { ...liveHashes, ...backupHashes };
    writeFileSync(FILE_HASHES_PATH, JSON.stringify(merged, null, 2) + '\n');
  }

  // ── Restore claude logs ──────────────────────────────────────────────────
  // We rm + cp rather than merge — the user explicitly opted into a
  // replay, so the live logs should match the backup byte-for-byte.
  const logsBackup = backupClaudeLogsDir(opts.name);
  if (existsSync(logsBackup)) {
    if (existsSync(claudeLogsLive)) rmSync(claudeLogsLive, { recursive: true, force: true });
    mkdirSync(dirname(claudeLogsLive), { recursive: true });
    cpSync(logsBackup, claudeLogsLive, { recursive: true });
  }

  return manifest;
}

function readClaudeLogsPath(projectEntry: { jobs?: Record<string, { parameters?: Record<string, unknown> }> }): string | undefined {
  const params = projectEntry.jobs?.claude?.parameters;
  const path = params?.['path'];
  return typeof path === 'string' && path.length > 0 ? path : undefined;
}
