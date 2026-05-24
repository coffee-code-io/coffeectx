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
  type AuthSettings,
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

/**
 * Persist a complete skill-job config block atomically.
 *
 * Writes `projects.<p>.jobs[<job>]` with any provided fields, leaving keys
 * the caller didn't set untouched. Used by the UI's "Configure skill"
 * dialog so a single click can wire auth + env + enable for a freshly
 * installed skill. Does NOT register the job in the scheduler's DB — the
 * caller pairs this with `setJobEnabled(...)` (which also runs
 * `upsertJob`) when flipping `enabled: true`, so the new row shows up in
 * `job list` and the scheduler picks it up on the next config-poll tick.
 */
export function setProjectJobConfig(
  projectName: string,
  jobName: string,
  patch: {
    enabled?: boolean;
    env?: Record<string, string>;
    auth?: AuthSettings;
    /**
     * Trigger override. `null` clears the override (re-enabling the
     * SKILL.md `coffeecode.job.triggers` default); `[]` makes the job
     * manual-only; otherwise the array replaces the SKILL.md triggers
     * wholesale. Loosely typed because the indexer's `JobTrigger` and the
     * core's `SkillTrigger` are kept in lockstep but live in different
     * packages.
     */
    triggers?: unknown[] | null;
  },
): void {
  updateConfig(cfg => {
    const project = cfg.projects[projectName];
    if (!project) throw new Error(`project "${projectName}" not in config`);
    if (!project.jobs) project.jobs = {};
    const prior = project.jobs[jobName] ?? {};
    const next = { ...prior };

    if (patch.enabled !== undefined) next.enabled = patch.enabled;

    if (patch.env !== undefined) {
      // Drop empty-string values — leaving a key with empty string in the
      // config would otherwise mask the env's "unset" state. If the user
      // wants to literally clear a var they can do it by editing the YAML.
      const filtered: Record<string, string> = {};
      for (const [k, v] of Object.entries(patch.env)) {
        if (typeof v === 'string' && v.length > 0) filtered[k] = v;
      }
      next.env = filtered;
    }

    if (patch.auth !== undefined) {
      const params = { ...(next.parameters ?? {}) };
      // Strip empty-string fields from the auth block; same reasoning as env.
      const cleanedAuth: AuthSettings = {};
      if (patch.auth.authType) cleanedAuth.authType = patch.auth.authType;
      if (patch.auth.model)    cleanedAuth.model    = patch.auth.model;
      if (patch.auth.apiKey)   cleanedAuth.apiKey   = patch.auth.apiKey;
      if (patch.auth.baseUrl)  cleanedAuth.baseUrl  = patch.auth.baseUrl;
      params['auth'] = cleanedAuth;
      next.parameters = params;
    }

    if (patch.triggers !== undefined) {
      if (patch.triggers === null) delete next.triggers;
      else next.triggers = patch.triggers;
    }

    project.jobs[jobName] = next;
  });
}

/**
 * Write a per-target skill filter (`projects.<p>.skills.<target>`).
 * `include`/`exclude` arrays replace whatever was there; pass `null` to
 * remove that target's entry entirely (back to "all skills visible").
 */
export function setProjectSkillFilter(
  projectName: string,
  target: 'uiAgent' | 'indexingAgents' | 'jobs',
  patch: { include?: string[] | null; exclude?: string[] | null } | null,
): void {
  updateConfig(cfg => {
    const project = cfg.projects[projectName];
    if (!project) throw new Error(`project "${projectName}" not in config`);
    if (!project.skills) project.skills = {};

    if (patch === null) {
      delete project.skills[target];
      return;
    }

    const next: { include?: string[]; exclude?: string[] } = { ...(project.skills[target] ?? {}) };
    if (patch.include !== undefined) {
      if (patch.include === null || patch.include.length === 0) delete next.include;
      else next.include = patch.include;
    }
    if (patch.exclude !== undefined) {
      if (patch.exclude === null || patch.exclude.length === 0) delete next.exclude;
      else next.exclude = patch.exclude;
    }
    if (Object.keys(next).length === 0) delete project.skills[target];
    else project.skills[target] = next;
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
