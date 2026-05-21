/**
 * Handlers for the `job` subcommands: list, on, off, trigger, status.
 */

import { updateConfig, resolveJobParameters, type Db, type CoffeectxConfig } from '@coffeectx/core';
import type { ProjectEntry } from '@coffeectx/core';
import type { Job, JobContext } from './types.js';
import { buildJobs } from './registry.js';

type ProjectInfo = ProjectEntry & { name: string };

interface CliCtx {
  db: Db;
  dbPath: string;
  project: ProjectInfo;
  config: CoffeectxConfig;
}

/**
 * Ensure every registered job has a row in `jobs`, then reconcile the live
 * enabled flag from config (config wins). Mirrors what the scheduler does on
 * boot so `job list` works correctly before `daemonize` has ever run.
 */
function ensureJobsRegistered(ctx: CliCtx, jobs: Job[]): void {
  const projectJobs = ctx.config.projects[ctx.project.name]?.jobs ?? {};
  for (const job of jobs) {
    const created = ctx.db.upsertJob(job.name, { description: job.description, defaultEnabled: job.defaultEnabled });
    const cfgEntry = projectJobs[job.name];
    if (cfgEntry?.enabled !== undefined) {
      ctx.db.setJobEnabled(job.name, cfgEntry.enabled);
    } else if (created) {
      ctx.db.setJobEnabled(job.name, job.defaultEnabled);
    }
  }
}

export function jobList(ctx: CliCtx): void {
  const jobs = buildJobs(ctx.db, ctx.config, ctx.project.name);
  ensureJobsRegistered(ctx, jobs);

  const rows = ctx.db.listJobs();
  if (rows.length === 0) {
    console.log('No jobs registered.');
    return;
  }
  const widthName = Math.max(...rows.map(r => r.name.length), 4);
  console.log(`${'NAME'.padEnd(widthName)}  ENABLED  STATUS    LAST RUN              LAST RESULT  MESSAGE`);
  for (const r of rows) {
    const en = r.enabled ? 'yes' : 'no ';
    const status = r.status.padEnd(8);
    const last = (r.lastEndedAt ?? r.lastStartedAt ?? '—').padEnd(20);
    const result = (r.lastResult ?? '—').padEnd(11);
    const msg = (r.lastError ? `error: ${r.lastError}` : r.lastMessage ?? '');
    console.log(`${r.name.padEnd(widthName)}  ${en}      ${status}  ${last}  ${result}  ${msg}`);
  }
}

export function jobOn(ctx: CliCtx, name: string): void {
  if (!ensureJobExists(ctx, name)) return;
  setProjectJobEnabled(ctx.project.name, name, true);
  ctx.db.setJobEnabled(name, true);
  console.log(`Enabled "${name}" for project "${ctx.project.name}"`);
}

export function jobOff(ctx: CliCtx, name: string): void {
  if (!ensureJobExists(ctx, name)) return;
  setProjectJobEnabled(ctx.project.name, name, false);
  ctx.db.setJobEnabled(name, false);
  console.log(`Disabled "${name}" for project "${ctx.project.name}"`);
}

function setProjectJobEnabled(projectName: string, jobName: string, enabled: boolean): void {
  updateConfig(cfg => {
    const project = cfg.projects[projectName];
    if (!project) throw new Error(`project "${projectName}" not in config`);
    if (!project.jobs) project.jobs = {};
    project.jobs[jobName] = { ...(project.jobs[jobName] ?? {}), enabled };
  });
}

export async function jobTrigger(ctx: CliCtx, name: string, now: boolean): Promise<number> {
  const jobs = buildJobs(ctx.db, ctx.config, ctx.project.name);
  ensureJobsRegistered(ctx, jobs);
  const job = jobs.find(j => j.name === name);
  if (!job) {
    console.error(`Unknown job: "${name}"`);
    return 1;
  }
  if (!now) {
    ctx.db.setJobTriggerPending(name);
    console.log(`Queued "${name}" — a running daemon will pick it up within ~2s.`);
    return 0;
  }
  console.log(`Running "${name}" inline...`);
  const runId = ctx.db.startJobRun(name, 'manual');
  const abortCtl = new AbortController();
  const jobCtx: JobContext = {
    db: ctx.db,
    dbPath: ctx.dbPath,
    project: ctx.project,
    config: ctx.config,
    parameters: resolveJobParameters(ctx.config, ctx.project.name, name),
    signal: abortCtl.signal,
    log: (msg) => console.log(`[${name}] ${msg}`),
  };
  try {
    const result = await job.run(jobCtx);
    ctx.db.endJobRun(runId, 'ok', { message: result.message, metrics: result.metrics });
    console.log(`ok${result.message ? ` — ${result.message}` : ''}`);
    return 0;
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    ctx.db.endJobRun(runId, 'error', { error: message });
    console.error(`error: ${message}`);
    return 1;
  }
}

export function jobStatus(ctx: CliCtx, name?: string): void {
  const jobs = buildJobs(ctx.db, ctx.config, ctx.project.name);
  ensureJobsRegistered(ctx, jobs);
  const targets = name ? [name] : ctx.db.listJobs().map(r => r.name);
  for (const n of targets) {
    const row = ctx.db.getJob(n);
    if (!row) {
      console.error(`Unknown job: "${n}"`);
      continue;
    }
    console.log(`\n${n}`);
    console.log(`  description:   ${row.description ?? '—'}`);
    console.log(`  enabled:       ${row.enabled}`);
    console.log(`  status:        ${row.status}${row.currentRunId ? ` (run #${row.currentRunId})` : ''}`);
    console.log(`  last started:  ${row.lastStartedAt ?? '—'}`);
    console.log(`  last ended:    ${row.lastEndedAt ?? '—'}`);
    console.log(`  last result:   ${row.lastResult ?? '—'}`);
    if (row.lastMessage) console.log(`  last message:  ${row.lastMessage}`);
    if (row.lastError) console.log(`  last error:    ${row.lastError}`);
    if (row.lastMetrics) console.log(`  last metrics:  ${JSON.stringify(row.lastMetrics)}`);
    const runs = ctx.db.listJobRuns(n, 5);
    if (runs.length > 0) {
      console.log(`  recent runs:`);
      for (const r of runs) {
        const dur = r.endedAt ? msBetween(r.startedAt, r.endedAt) : '...';
        console.log(`    #${r.id} ${r.triggerKind.padEnd(11)} ${r.startedAt} → ${r.result ?? 'running'} (${dur})`);
      }
    }
  }
}

function ensureJobExists(ctx: CliCtx, name: string): boolean {
  const row = ctx.db.getJob(name);
  if (row) return true;
  // Register on demand so users can flip the switch before first boot.
  const jobs = buildJobs(ctx.db, ctx.config, ctx.project.name);
  const job = jobs.find(j => j.name === name);
  if (!job) {
    console.error(`Unknown job: "${name}". Try \`job list\`.`);
    return false;
  }
  ctx.db.upsertJob(job.name, { description: job.description, defaultEnabled: job.defaultEnabled });
  return true;
}

function msBetween(start: string, end: string): string {
  const ms = Date.parse(end) - Date.parse(start);
  if (Number.isNaN(ms)) return '?ms';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
