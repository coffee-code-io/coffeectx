/**
 * Restore a project to a captured backup state. Order matters:
 *   1. Wipe live DB, snapshot store, and project-scoped hashes.
 *   2. Copy backup snapshots, DB, and agent logs back into their live
 *      locations.
 *   3. Merge backup's filtered file-hashes into the live JSON.
 *
 * After restore, `run` (or the indexer daemon) can execute as if nothing
 * had happened — modulo the wall clock, which `run` controls via
 * `closeBeforeMs`.
 */

import {
  cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { loadConfig } from '@coffeectx/core';
import {
  FILE_HASHES_PATH,
  backupAgentLogsDir, backupDbPath, backupHashesPath,
  backupManifestPath, backupSnapshotsDir,
  dbAndSiblings, projectDbPath, projectSnapshotDir,
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

  const _repoPath = projectEntry.repoPath ?? manifest.repoPath;
  void _repoPath;
  // Manifest is the source of truth for where the agent logs landed when
  // the backup was taken — restore writes them back to the same path.
  const logsLivePath = manifest.sources.agentLogs.path;
  const logsKind = manifest.sources.agentLogs.kind;

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

  // ── Restore agent logs ───────────────────────────────────────────────────
  // We rm + cp rather than merge — the user explicitly opted into a
  // replay, so the live logs should match the backup byte-for-byte.
  // For codex (single sqlite file) the backup contains `agent-logs/<basename>`;
  // for claude / pi the backup root IS the live root.
  const logsBackup = backupAgentLogsDir(opts.name);
  if (logsLivePath && existsSync(logsBackup)) {
    if (logsKind === 'codex') {
      const fname = basename(logsLivePath);
      const src = join(logsBackup, fname);
      if (existsSync(src)) {
        if (existsSync(logsLivePath)) rmSync(logsLivePath, { force: true });
        mkdirSync(dirname(logsLivePath), { recursive: true });
        cpSync(src, logsLivePath);
      }
    } else if (hasContents(logsBackup)) {
      if (existsSync(logsLivePath)) rmSync(logsLivePath, { recursive: true, force: true });
      mkdirSync(dirname(logsLivePath), { recursive: true });
      cpSync(logsBackup, logsLivePath, { recursive: true });
    }
  }

  return manifest;
}

function hasContents(dir: string): boolean {
  try { return statSync(dir).isDirectory() && readdirSync(dir).length > 0; }
  catch { return false; }
}
