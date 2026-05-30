/** Programmatic entry points for the replay harness. The CLI in
 *  `./cli.ts` is the usual entrypoint; this index re-exports the same
 *  helpers for callers that want to script their own iteration loops. */

export { backup } from './backup.js';
export type { BackupOptions, BackupResult } from './backup.js';
export { restore } from './restore.js';
export type { RestoreOptions } from './restore.js';
export { resetDb, resetHashes, resetSnapshots } from './reset.js';
export { record } from './record.js';
export type { RecordOptions } from './record.js';
export { runFullChain } from './run.js';
export type { RunOptions, RunResult } from './run.js';
export type { BackupManifest } from './manifest.js';
export {
  BACKUPS_DIR, SNAPSHOTS_DIR, FILE_HASHES_PATH, CLAUDE_PROJECTS_DIR,
  projectDbPath, projectSnapshotDir, claudeLogsDirFor, encodeClaudeProjectDir,
} from './paths.js';
