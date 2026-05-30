/**
 * Backup manifest schema — written into <backup>/manifest.json and read
 * back during list / restore. Intentionally minimal: captures what was
 * snapshotted + when, so `restore` can wipe + repopulate without
 * inspecting the on-disk trees.
 */

import { readFileSync, writeFileSync } from 'node:fs';

export interface BackupManifest {
  project: string;
  repoPath: string;
  recordedAt: string;
  sources: {
    snapshots: { path: string; count: number; totalBytes: number };
    db:        { path: string; bytes: number };
    fileHashes:{ entryCount: number };
    claudeLogs:{ path: string; sessions: number; totalBytes: number };
  };
}

export function readManifest(path: string): BackupManifest {
  return JSON.parse(readFileSync(path, 'utf-8')) as BackupManifest;
}

export function writeManifest(path: string, manifest: BackupManifest): void {
  writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n');
}
