/**
 * Standalone snapshot supervisor — captures file changes under the
 * project's repoPath without running any indexing jobs. Used during the
 * "record" phase before `backup`. Process exits cleanly on SIGINT.
 *
 * NOTE: don't run this concurrently with the indexer daemon for the same
 * project. Both would race on the same snapshot index.jsonl.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { CLAUDE_DIR, loadConfig } from '@coffeectx/core';
import {
  PLANS_EXTENSIONS, SOURCE_EXTENSIONS, SnapshotSupervisor,
} from '@coffeectx/indexer/dist/lsp/snapshotSupervisor.js';

export interface RecordOptions {
  project: string;
  /** How often to print a status line (ms). Default 10 s. */
  statusIntervalMs?: number;
}

export async function record(opts: RecordOptions): Promise<void> {
  const config = loadConfig();
  const repoPath = config.projects[opts.project]?.repoPath;
  if (!repoPath) throw new Error(`project ${opts.project} has no repoPath set in config`);

  const plansDir = readPlansDir(config.projects[opts.project]) ?? join(CLAUDE_DIR, 'plans');
  const supervisor = new SnapshotSupervisor({
    projectName: opts.project,
    watches: [
      { rootPath: repoPath, extensions: SOURCE_EXTENSIONS },
      { rootPath: plansDir, extensions: PLANS_EXTENSIONS, allowDottedSegments: true },
    ],
  });

  const startedAt = Date.now();
  console.log(`[record] starting supervisor for ${opts.project} @ ${repoPath}`);
  await supervisor.start();
  console.log(`[record] ready after ${Date.now() - startedAt} ms — watching for changes, Ctrl-C to stop`);

  const interval = setInterval(() => {
    const drained = supervisor.drainSince(repoPath, 0);
    let count = 0;
    let latestTs = 0;
    for (const arr of drained.values()) {
      count += arr.length;
      for (const e of arr) if (e.ts > latestTs) latestTs = e.ts;
    }
    const latestStr = latestTs > 0 ? new Date(latestTs).toISOString() : '(none)';
    console.log(`[record] snapshots so far: ${count} files, last @ ${latestStr}`);
  }, opts.statusIntervalMs ?? 10_000);

  return new Promise<void>(resolve => {
    const onSignal = async () => {
      clearInterval(interval);
      console.log('[record] stopping supervisor…');
      try { await supervisor.stop(); } catch { /* idempotent */ }
      console.log('[record] stopped');
      resolve();
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  });
}

function readPlansDir(projectEntry: { jobs?: Record<string, { parameters?: Record<string, unknown> }> } | undefined): string | undefined {
  const raw = projectEntry?.jobs?.plans?.parameters?.['plansDir'];
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  return raw.startsWith('~/') ? `${homedir()}/${raw.slice(2)}` : raw;
}
