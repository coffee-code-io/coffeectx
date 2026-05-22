/**
 * Build the list of jobs the scheduler manages for a given project.
 *
 * Built-in jobs:
 *   - lsp[:<suffix>] : one per `lsp` / `lsp:*` entry in project.jobs. Each reads
 *                      its own `parameters.{repoPath, lspCommand, intervalMs}`.
 *                      If no lsp* entry exists in config, a single default `lsp`
 *                      job is registered (defaultEnabled=false).
 *   - logs           : reads `parameters.{logsPath, logsNewerThan?, intervalMs?}`.
 *   - skill:<dir>    : one per skill directory under indexer/skills/. Triggered by
 *                      onTypeInsert on the agent-log event types, with a fallback
 *                      timer. Reads `parameters.{auth, batchStep?, intervalMs?}`.
 */

import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import type { Db, CoffeectxConfig, AuthSettings } from '@coffeectx/core';
import type { Job, JobTrigger } from './types.js';
import { indexWithLsp } from '../lsp/indexSymbols.js';
import { indexLogs } from '../agentLog/indexLogs.js';
import { runOneSkill, listAvailableSkills, loadSkillDef } from '../agentRun/indexAgent.js';
import { loadFileHashes } from '../fileHashes.js';
import { indexPlans } from '../plans/indexPlans.js';

const DEFAULT_LSP_INTERVAL_MS = 10 * 60_000;
const DEFAULT_LOGS_INTERVAL_MS = 30_000;
const DEFAULT_PLANS_INTERVAL_MS = 5 * 60_000;
const DEFAULT_SKILL_FALLBACK_INTERVAL_MS = 10 * 60_000;
const DEFAULT_LSP_COMMAND = 'typescript-language-server --stdio';
const DEFAULT_PLANS_DIR = join(homedir(), '.claude', 'plans');

/**
 * Event types whose insertion should trigger agent skill jobs.
 * AgentMessage replaces AgentThought as the primary signal of agent intent;
 * Plan inserts are also interesting (a new plan was authored).
 */
const SKILL_TRIGGER_TYPES = [
  'UserInput', 'FileOperation', 'ShellExecution',
  'AgentQuestion', 'AgentMessage', 'Plan',
];

interface SkillJobState {
  processedEventIds?: string[];
  /** Catch-up cursor (rowid) maintained by the scheduler. */
  cursor?: number;
}

function projectJobParams(
  config: CoffeectxConfig,
  projectName: string,
  jobName: string,
): Record<string, unknown> {
  return config.projects[projectName]?.jobs?.[jobName]?.parameters ?? {};
}

function readIntervalMs(params: Record<string, unknown>, fallback: number): number {
  const v = params['intervalMs'];
  return typeof v === 'number' && v > 0 ? v : fallback;
}

function readString(params: Record<string, unknown>, key: string): string | undefined {
  const v = params[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** Names of project.jobs keys that represent an LSP job instance. */
function discoverLspJobNames(config: CoffeectxConfig, projectName: string): string[] {
  const projectJobs = config.projects[projectName]?.jobs ?? {};
  const names = Object.keys(projectJobs).filter(k => k === 'lsp' || k.startsWith('lsp:'));
  // Always register a default `lsp` job so it shows up in `job list` even if
  // the user hasn't configured one yet.
  if (!names.includes('lsp')) names.unshift('lsp');
  return names;
}

function buildLspJob(jobName: string, config: CoffeectxConfig, projectName: string): Job {
  const params = projectJobParams(config, projectName, jobName);
  return {
    name: jobName,
    description: 'Index repository source files via Language Server Protocol.',
    defaultEnabled: false,
    triggers: [{ kind: 'timer', intervalMs: readIntervalMs(params, DEFAULT_LSP_INTERVAL_MS) }],
    async run(ctx) {
      const repoPath = readString(ctx.parameters, 'repoPath') ?? ctx.project.repoPath;
      if (!repoPath) return { message: 'no repoPath configured — skipped' };

      const lspCmd = readString(ctx.parameters, 'lspCommand') ?? DEFAULT_LSP_COMMAND;
      const [lspBin, ...lspArgs] = lspCmd.trim().split(/\s+/).filter(Boolean);
      if (!lspBin) throw new Error(`invalid lspCommand: "${lspCmd}"`);
      const lspBinPath = lspBin.startsWith('~/') ? `${homedir()}/${lspBin.slice(2)}` : lspBin;

      const hashes = loadFileHashes();
      const r = await indexWithLsp(ctx.db, resolve(repoPath), lspBinPath, lspArgs, { hashes });

      if (r.skipped) return { message: 'no source files changed' };
      if (r.errors.length > 0) {
        const first = r.errors[0]!;
        throw new Error(`${r.errors.length} file error(s); first: ${first.file}: ${first.error}`);
      }
      return { message: `${r.files} files, ${r.nodes} nodes`, metrics: { files: r.files, nodes: r.nodes } };
    },
  };
}

function buildLogsJob(config: CoffeectxConfig, projectName: string): Job {
  const params = projectJobParams(config, projectName, 'logs');
  return {
    name: 'logs',
    description: 'Index Claude Code JSONL session logs.',
    defaultEnabled: true,
    triggers: [{ kind: 'timer', intervalMs: readIntervalMs(params, DEFAULT_LOGS_INTERVAL_MS) }],
    async run(ctx) {
      const logsPath = readString(ctx.parameters, 'logsPath');
      if (!logsPath) return { message: 'no logsPath configured — skipped' };

      const newerThanStr = readString(ctx.parameters, 'logsNewerThan');
      const newerThan = newerThanStr ? new Date(newerThanStr) : undefined;
      const hashes = loadFileHashes();
      const r = await indexLogs(ctx.db, [resolve(logsPath)], { newerThan, hashes });

      if (r.errors.length > 0) {
        const first = r.errors[0]!;
        throw new Error(`${r.errors.length} file error(s); first: ${first.file}: ${first.error}`);
      }
      return {
        message: `${r.files} files (${r.skipped} skipped), ${r.sessions} sessions, ${r.inserted} inserted`,
        metrics: { files: r.files, skipped: r.skipped, sessions: r.sessions, events: r.events, inserted: r.inserted },
      };
    },
  };
}

function buildPlansJob(config: CoffeectxConfig, projectName: string): Job {
  const params = projectJobParams(config, projectName, 'plans');
  return {
    name: 'plans',
    description: 'Ingest Claude plan-mode markdown files from ~/.claude/plans/.',
    defaultEnabled: true,
    triggers: [{ kind: 'timer', intervalMs: readIntervalMs(params, DEFAULT_PLANS_INTERVAL_MS) }],
    async run(ctx) {
      const plansDir = readString(ctx.parameters, 'plansDir') ?? DEFAULT_PLANS_DIR;
      const r = await indexPlans(ctx.db, { plansDir: resolve(plansDir) });
      if (r.errors.length > 0) {
        const first = r.errors[0]!;
        throw new Error(`${r.errors.length} plan error(s); first: ${first.path}: ${first.error}`);
      }
      return {
        message: `${r.scanned} scanned, ${r.inserted} new, ${r.patched} patched, ${r.skipped} unchanged`,
        metrics: { scanned: r.scanned, inserted: r.inserted, patched: r.patched, skipped: r.skipped },
      };
    },
  };
}

function buildSkillJob(jobName: string, dirName: string, description: string, config: CoffeectxConfig, projectName: string): Job {
  const params = projectJobParams(config, projectName, jobName);
  const triggers: JobTrigger[] = [
    { kind: 'onTypeInsert', typeNames: SKILL_TRIGGER_TYPES },
    { kind: 'timer', intervalMs: readIntervalMs(params, DEFAULT_SKILL_FALLBACK_INTERVAL_MS) },
  ];
  return {
    name: jobName,
    description,
    defaultEnabled: dirName === 'local-decisions',
    triggers,
    async run(ctx) {
      const initial = (ctx.db.getJobState<SkillJobState>(jobName)) ?? {};
      const processed = new Set<string>(initial.processedEventIds ?? []);
      const auth = (ctx.parameters['auth'] as AuthSettings | undefined) ?? {};
      const batchStep = typeof ctx.parameters['batchStep'] === 'number'
        ? (ctx.parameters['batchStep'] as number)
        : undefined;
      // Skill jobs are how the indexer writes structured knowledge — the agent
      // MUST be able to call upsert_entries. The project's mcp.tools.insert
      // flag only gates the *external* MCP server's exposure of the tool to
      // Claude Desktop & friends; the in-process skill agent is unrelated.
      const allowInsert = true;

      const r = await runOneSkill({
        db: ctx.db,
        projectName: ctx.project.name,
        skillDirName: dirName,
        processedEventIds: processed,
        auth,
        batchStep,
        allowInsert,
        onBatchProcessed: async (newlyProcessed) => {
          for (const id of newlyProcessed) processed.add(id);
          // Re-read state to preserve other keys the scheduler may have updated.
          const fresh = (ctx.db.getJobState<SkillJobState>(jobName)) ?? {};
          fresh.processedEventIds = Array.from(processed);
          ctx.db.setJobState(jobName, fresh);
        },
      });

      if (r.errors.length > 0) {
        const first = r.errors[0]!;
        throw new Error(`${r.errors.length} skill error(s); first: ${first.error}`);
      }
      return {
        message: `${r.sessions} sessions, ${r.events} events, ${r.batches} batches`,
        metrics: { sessions: r.sessions, events: r.events, batches: r.batches },
      };
    },
  };
}

/**
 * Build every job the scheduler knows about for the given project.
 */
export function buildJobs(_db: Db, config: CoffeectxConfig, projectName: string): Job[] {
  const jobs: Job[] = [];

  for (const name of discoverLspJobNames(config, projectName)) {
    jobs.push(buildLspJob(name, config, projectName));
  }

  jobs.push(buildLogsJob(config, projectName));
  jobs.push(buildPlansJob(config, projectName));

  for (const dirName of listAvailableSkills()) {
    const def = loadSkillDef(dirName);
    if (!def) continue;
    jobs.push(buildSkillJob(`skill:${dirName}`, dirName, def.description, config, projectName));
  }

  return jobs;
}
