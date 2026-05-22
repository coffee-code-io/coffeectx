/**
 * Job control primitives shared by the CLI (`coffeectx-index job …`) and the
 * web-UI server. No console output — callers format and report as they like.
 */

import {
  updateConfig,
  resolveJobParameters,
  type Db,
  type CoffeectxConfig,
  type ProjectEntry,
} from '@coffeectx/core';
import type { Job, JobContext } from './types.js';
import { buildJobs } from './registry.js';
import { withRunLog } from './runLog.js';

export type ProjectInfo = ProjectEntry & { name: string };

/**
 * Ensure every job from the registry has a row in the project's DB, then
 * reconcile the live `enabled` flag from config (config wins). Mirrors what
 * the scheduler does on boot so a freshly-init'd project shows the right
 * picture before `daemonize` has ever run.
 */
export function ensureJobsRegistered(db: Db, config: CoffeectxConfig, projectName: string): Job[] {
  const jobs = buildJobs(db, config, projectName);
  const projectJobs = config.projects[projectName]?.jobs ?? {};
  for (const job of jobs) {
    const created = db.upsertJob(job.name, { description: job.description, defaultEnabled: job.defaultEnabled });
    const cfgEntry = projectJobs[job.name];
    if (cfgEntry?.enabled !== undefined) {
      db.setJobEnabled(job.name, cfgEntry.enabled);
    } else if (created) {
      db.setJobEnabled(job.name, job.defaultEnabled);
    }
  }
  return jobs;
}

/** Persist enable/disable for a job under `projects.<p>.jobs.<job>.enabled`. */
export function setProjectJobEnabled(projectName: string, jobName: string, enabled: boolean): void {
  updateConfig(cfg => {
    const project = cfg.projects[projectName];
    if (!project) throw new Error(`project "${projectName}" not in config`);
    if (!project.jobs) project.jobs = {};
    project.jobs[jobName] = { ...(project.jobs[jobName] ?? {}), enabled };
  });
}

/** Flip enabled in both config and DB. Returns nothing; throws on bad input. */
export function setJobEnabled(db: Db, config: CoffeectxConfig, projectName: string, jobName: string, enabled: boolean): void {
  // Ensure the job exists in the DB (registers it on demand).
  if (!db.getJob(jobName)) {
    const jobs = buildJobs(db, config, projectName);
    const job = jobs.find(j => j.name === jobName);
    if (!job) throw new Error(`unknown job "${jobName}"`);
    db.upsertJob(job.name, { description: job.description, defaultEnabled: job.defaultEnabled });
  }
  setProjectJobEnabled(projectName, jobName, enabled);
  db.setJobEnabled(jobName, enabled);
}

/** Set trigger_pending on a job; daemon picks it up within ~2s. */
export function queueJobTrigger(db: Db, jobName: string): void {
  db.setJobTriggerPending(jobName);
}

/** Run a job inline once. Used by `job trigger --now` and the UI's "run now" button. */
export async function runJobInline(
  db: Db,
  dbPath: string,
  project: ProjectInfo,
  config: CoffeectxConfig,
  jobName: string,
  log: (msg: string) => void = () => { /* swallow */ },
): Promise<{ ok: true; message?: string } | { ok: false; error: string }> {
  const jobs = buildJobs(db, config, project.name);
  const job = jobs.find(j => j.name === jobName);
  if (!job) return { ok: false, error: `unknown job "${jobName}"` };

  const runId = db.startJobRun(jobName, 'manual');
  const abortCtl = new AbortController();
  const ctx: JobContext = {
    db,
    dbPath,
    project,
    config,
    parameters: resolveJobParameters(config, project.name, jobName),
    signal: abortCtl.signal,
    log,
  };
  try {
    const result = await withRunLog(project.name, runId, () => job.run(ctx));
    db.endJobRun(runId, 'ok', { message: result.message, metrics: result.metrics });
    return { ok: true, message: result.message };
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    db.endJobRun(runId, 'error', { error: message });
    return { ok: false, error: message };
  }
}
