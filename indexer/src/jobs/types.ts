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
  | { kind: 'onTypeInsert'; typeNames: string[] }
  /**
   * Fires when any node of one of the named types transitions INTO `state`.
   * Used to gate downstream jobs on upstream completion — e.g. skill jobs run
   * only after the LSP indexer bumps event nodes from `extracted` → `linked`.
   */
  | { kind: 'onNodeState'; typeNames: string[]; state: string }
  /**
   * Standard 5-field cron expression (minute hour day-of-month month day-of-week).
   * The scheduler computes the next fire-time at install + after each fire and
   * arms a single `setTimeout`. Use for "every weekday at 9am" / "every 6h" /
   * "first of the month" cadences that don't fit a fixed `intervalMs`.
   */
  | { kind: 'cron'; expression: string };

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
  /** Unique scheduler ID, e.g. 'lsp', 'claude', 'local-decisions'. */
  name: string;
  description?: string;
  /** Initial enabled state when the job is first registered. */
  defaultEnabled: boolean;
  /** Empty triggers => manual-only. */
  triggers: JobTrigger[];
  /** Throw on error; the scheduler converts to job_runs.result='error'. */
  run(ctx: JobContext): Promise<JobRunResult>;
}
