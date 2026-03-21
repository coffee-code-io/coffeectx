/**
 * Daemon mode: watch the logs directory for new/changed .jsonl files and
 * trigger a full reindex on change, subject to a configurable rate limit.
 *
 * Rate-limit logic:
 *   - A short debounce (DEBOUNCE_MS) waits for rapid successive writes to settle.
 *   - After a run completes, the next run is allowed no sooner than rateLimitMs.
 *   - If a change arrives during the cooldown, it is scheduled for when the
 *     cooldown expires.
 */

import { watch } from 'node:fs';
import type { Db } from '@coffeectx/core';
import type { IndexLogsOptions } from './agentLog/indexLogs.js';
import { indexLogs } from './agentLog/indexLogs.js';
import { indexAgent } from './agentRun/indexAgent.js';
import type { FileHashStore } from './fileHashes.js';

const DEBOUNCE_MS = 5_000;

export interface DaemonOptions {
  db: Db;
  dbPath: string;
  logsPath: string;
  /** Minimum milliseconds between index runs. Default: 10 minutes. */
  rateLimitMs?: number;
  indexLogs?: boolean;
  indexAgent?: boolean;
  logOptions?: IndexLogsOptions;
  pathToQwenExecutable?: string;
  hashes?: FileHashStore;
}

export async function runDaemon(opts: DaemonOptions): Promise<void> {
  const {
    db,
    dbPath,
    logsPath,
    rateLimitMs = 10 * 60 * 1000,
    indexLogs: doLogs = true,
    indexAgent: doAgent = true,
    logOptions = {},
    pathToQwenExecutable,
    hashes,
  } = opts;

  let lastRunAt = 0;
  let debounce: NodeJS.Timeout | null = null;
  let cooldownScheduled: NodeJS.Timeout | null = null;
  let running = false;

  const runIndex = async () => {
    if (running) {
      // A run is already in progress; schedule a follow-up after it finishes.
      scheduleAfterCooldown();
      return;
    }
    running = true;
    lastRunAt = Date.now();
    console.log(`[daemon] Running index (${new Date().toISOString()})...`);
    try {
      if (doLogs) {
        const r = await indexLogs(db, [logsPath], { ...logOptions, hashes });
        console.log(`[daemon][logs] files=${r.files} skipped=${r.skipped} sessions=${r.sessions} inserted=${r.inserted}`);
      }
      if (doAgent) {
        const r = await indexAgent({ db, dbPath, pathToQwenExecutable });
        console.log(`[daemon][agent] batches=${r.batches}`);
        if (r.errors.length > 0) {
          for (const { error } of r.errors) console.error(`[daemon][agent] ${error}`);
        }
      }
    } catch (err) {
      console.error(`[daemon] Index error: ${(err as Error).message}`);
    } finally {
      running = false;
    }
  };

  const scheduleAfterCooldown = () => {
    if (cooldownScheduled) return; // already queued
    const delay = Math.max(0, lastRunAt + rateLimitMs - Date.now());
    console.log(`[daemon] Rate-limited — next run in ${Math.round(delay / 1000)}s`);
    cooldownScheduled = setTimeout(() => {
      cooldownScheduled = null;
      void runIndex();
    }, delay);
  };

  const onFileChange = (filename: string | null) => {
    if (!filename?.endsWith('.jsonl')) return;

    // Clear any pending debounce and restart it.
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = null;
      const sinceLastRun = Date.now() - lastRunAt;
      if (sinceLastRun >= rateLimitMs) {
        void runIndex();
      } else {
        scheduleAfterCooldown();
      }
    }, DEBOUNCE_MS);
  };

  // Initial run on startup.
  await runIndex();

  console.log(`[daemon] Watching "${logsPath}" (rate limit: ${rateLimitMs / 1000}s)...`);

  const watcher = watch(logsPath, { persistent: true }, (_, filename) => {
    onFileChange(filename);
  });

  watcher.on('error', (err) => {
    console.error(`[daemon] Watcher error: ${err.message}`);
  });

  // Graceful shutdown.
  const shutdown = () => {
    console.log('\n[daemon] Shutting down...');
    watcher.close();
    if (debounce) clearTimeout(debounce);
    if (cooldownScheduled) clearTimeout(cooldownScheduled);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
