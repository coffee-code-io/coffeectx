/**
 * Per-job-run log capture.
 *
 * Wraps `process.stdout.write` and `process.stderr.write` while a job runs so
 * everything the job (and its dependencies) print also gets appended to a
 * per-run log file under `~/.coffeecode/logs/<project>/<runId>.log`.
 *
 * Safe because the scheduler serialises jobs (single global mutex) — at most
 * one capture is active at a time. The wrapper restores the original write
 * functions and closes the file in `finally`.
 */

import { createWriteStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { COFFEECODE_DIR } from '@coffeectx/core';

export const LOG_ROOT = join(COFFEECODE_DIR, 'logs');

/** Where the log file for a given project + run id lives. */
export function logPathFor(projectName: string, runId: number): string {
  const safeProject = projectName.replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(LOG_ROOT, safeProject, `${runId}.log`);
}

/**
 * Capture stdout/stderr for the duration of `fn`. On any throw the file is
 * still closed and writes are restored.
 */
export async function withRunLog<T>(
  projectName: string,
  runId: number,
  fn: () => Promise<T>,
): Promise<T> {
  const logPath = logPathFor(projectName, runId);
  mkdirSync(dirname(logPath), { recursive: true });

  const stream = createWriteStream(logPath, { flags: 'a' });
  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);

  const wrap = (orig: typeof process.stdout.write): typeof process.stdout.write =>
    ((chunk: unknown, ...rest: unknown[]) => {
      try { stream.write(chunk as Parameters<typeof stream.write>[0]); } catch { /* swallow */ }
      // @ts-expect-error variadic forwarding to preserve `cb`/`encoding` overloads
      return orig(chunk, ...rest);
    }) as typeof process.stdout.write;

  process.stdout.write = wrap(origStdoutWrite);
  process.stderr.write = wrap(origStderrWrite);

  stream.write(`==== run ${runId} for "${projectName}" — started ${new Date().toISOString()}\n`);

  try {
    const value = await fn();
    stream.write(`==== run ${runId} finished ok ${new Date().toISOString()}\n`);
    return value;
  } catch (err) {
    const e = err as Error;
    stream.write(`==== run ${runId} FAILED ${new Date().toISOString()}\n${e.stack ?? e.message}\n`);
    throw err;
  } finally {
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
    await new Promise<void>(r => stream.end(r));
  }
}

/** Read a run log from disk, returning null if it doesn't exist. */
export function readRunLog(projectName: string, runId: number): string | null {
  const p = logPathFor(projectName, runId);
  if (!existsSync(p)) return null;
  return readFileSync(p, 'utf-8');
}
