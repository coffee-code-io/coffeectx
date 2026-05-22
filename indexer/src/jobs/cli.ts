/**
 * Handlers for the `job` subcommands: list, on, off, trigger, status.
 *
 * All persistence / mutation logic lives in `control.ts`; this file is just
 * formatting and CLI I/O.
 */

import type { Db, CoffeectxConfig, ProjectEntry } from '@coffeectx/core';
import { ensureJobsRegistered, setJobEnabled, queueJobTrigger, runJobInline } from './control.js';
import { buildJobs } from './registry.js';

type ProjectInfo = ProjectEntry & { name: string };

interface CliCtx {
  db: Db;
  dbPath: string;
  project: ProjectInfo;
  config: CoffeectxConfig;
}

export function jobList(ctx: CliCtx): void {
  ensureJobsRegistered(ctx.db, ctx.config, ctx.project.name);

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
  try {
    setJobEnabled(ctx.db, ctx.config, ctx.project.name, name, true);
    console.log(`Enabled "${name}" for project "${ctx.project.name}"`);
  } catch (err) {
    console.error((err as Error).message + '. Try `job list`.');
  }
}

export function jobOff(ctx: CliCtx, name: string): void {
  try {
    setJobEnabled(ctx.db, ctx.config, ctx.project.name, name, false);
    console.log(`Disabled "${name}" for project "${ctx.project.name}"`);
  } catch (err) {
    console.error((err as Error).message + '. Try `job list`.');
  }
}

export async function jobTrigger(ctx: CliCtx, name: string, now: boolean): Promise<number> {
  ensureJobsRegistered(ctx.db, ctx.config, ctx.project.name);
  const jobs = buildJobs(ctx.db, ctx.config, ctx.project.name);
  if (!jobs.find(j => j.name === name)) {
    console.error(`Unknown job: "${name}"`);
    return 1;
  }
  if (!now) {
    queueJobTrigger(ctx.db, name);
    console.log(`Queued "${name}" — a running daemon will pick it up within ~2s.`);
    return 0;
  }
  console.log(`Running "${name}" inline...`);
  const result = await runJobInline(ctx.db, ctx.dbPath, ctx.project, ctx.config, name,
    (msg) => console.log(`[${name}] ${msg}`));
  if (result.ok) {
    console.log(`ok${result.message ? ` — ${result.message}` : ''}`);
    return 0;
  }
  console.error(`error: ${result.error}`);
  return 1;
}

export function jobStatus(ctx: CliCtx, name?: string): void {
  ensureJobsRegistered(ctx.db, ctx.config, ctx.project.name);
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

function msBetween(start: string, end: string): string {
  const ms = Date.parse(end) - Date.parse(start);
  if (Number.isNaN(ms)) return '?ms';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
