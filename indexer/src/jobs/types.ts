/**
 * Scheduler job interface. Each indexer/skill implements this contract.
 *
 * A job declares its triggers (timer and/or onTypeInsert) and provides a
 * `run(ctx)` method. The scheduler owns lifecycle and persistence; the job
 * itself only knows how to do its unit of work.
 */

import type { Db, CoffeectxConfig, ProjectEntry } from '@coffeectx/core';

export type JobTrigger =
  | { kind: 'timer'; intervalMs: number }
  | { kind: 'onTypeInsert'; typeNames: string[] };

export interface JobContext {
  db: Db;
  dbPath: string;
  project: ProjectEntry & { name: string };
  config: CoffeectxConfig;
  /** Resolved per-job parameters (project.jobs[name].parameters). */
  parameters: Record<string, unknown>;
  signal: AbortSignal;
  log: (msg: string) => void;
}

export interface JobRunResult {
  message?: string;
  metrics?: Record<string, number>;
}

export interface Job {
  /** Unique scheduler ID, e.g. 'lsp', 'logs', 'skill:local-decisions'. */
  name: string;
  description?: string;
  /** Initial enabled state when the job is first registered. */
  defaultEnabled: boolean;
  /** Empty triggers => manual-only. */
  triggers: JobTrigger[];
  /** Throw on error; the scheduler converts to job_runs.result='error'. */
  run(ctx: JobContext): Promise<JobRunResult>;
}
