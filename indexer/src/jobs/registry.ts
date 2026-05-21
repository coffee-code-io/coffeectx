/**
 * Build the list of jobs the scheduler manages.
 *
 * Built-in jobs:
 *   - lsp     : timer, wraps indexWithLsp
 *   - logs    : timer, wraps indexLogs (replaces the old fs.watch daemon)
 *   - skill:<dir> : one per skill directory under indexer/skills/. Triggered by
 *                   onTypeInsert on the agent-log event types, with a fallback timer.
 */

import { resolve } from 'node:path';
import { homedir } from 'node:os';
import type { Db, CoffeectxConfig } from '@coffeectx/core';
import type { Job, JobTrigger } from './types.js';
import { indexWithLsp } from '../lsp/indexSymbols.js';
import { resolveLspCommand } from '../lsp/config.js';
import { indexLogs } from '../agentLog/indexLogs.js';
import { runOneSkill, listAvailableSkills, loadSkillDef } from '../agentRun/indexAgent.js';
import { loadFileHashes } from '../fileHashes.js';

const DEFAULT_LSP_INTERVAL_MS = 10 * 60_000;
const DEFAULT_LOGS_INTERVAL_MS = 30_000;
const DEFAULT_SKILL_FALLBACK_INTERVAL_MS = 10 * 60_000;

/** Event types whose insertion should trigger agent skill jobs. */
const SKILL_TRIGGER_TYPES = ['UserInput', 'FileOperation', 'ShellExecution', 'AgentQuestion'];

interface SkillJobState {
  processedEventIds?: string[];
  /** Catch-up cursor (rowid) maintained by the scheduler. */
  cursor?: number;
}

function jobOverrides(config: CoffeectxConfig, name: string): { enabled?: boolean; intervalMs?: number } {
  return config.jobs?.[name] ?? {};
}

/** Build every job the scheduler knows about for the active project. */
export function buildJobs(_db: Db, config: CoffeectxConfig): Job[] {
  const jobs: Job[] = [];

  // ── lsp ──────────────────────────────────────────────────────────────────
  const lspOverride = jobOverrides(config, 'lsp');
  jobs.push({
    name: 'lsp',
    description: 'Index repository source files via Language Server Protocol.',
    defaultEnabled: false,
    triggers: [{ kind: 'timer', intervalMs: lspOverride.intervalMs ?? DEFAULT_LSP_INTERVAL_MS }],
    async run(ctx) {
      const repoPath = ctx.project.repoPath;
      if (!repoPath) {
        return { message: 'no repoPath configured — skipped' };
      }
      const absRepo = resolve(repoPath);
      const lspCmd = config.lsp.servers?.['typescript'] ?? resolveLspCommand(undefined, 'typescript');
      const [lspBin, ...lspArgs] = lspCmd.trim().split(/\s+/).filter(Boolean);
      if (!lspBin) throw new Error(`invalid LSP command: "${lspCmd}"`);
      const lspBinPath = lspBin.startsWith('~/') ? `${homedir()}/${lspBin.slice(2)}` : lspBin;

      const hashes = loadFileHashes();
      const r = await indexWithLsp(ctx.db, absRepo, lspBinPath, lspArgs, { hashes });

      if (r.skipped) return { message: 'no source files changed' };
      if (r.errors.length > 0) {
        const first = r.errors[0]!;
        throw new Error(`${r.errors.length} file error(s); first: ${first.file}: ${first.error}`);
      }
      return { message: `${r.files} files, ${r.nodes} nodes`, metrics: { files: r.files, nodes: r.nodes } };
    },
  });

  // ── logs ─────────────────────────────────────────────────────────────────
  const logsOverride = jobOverrides(config, 'logs');
  jobs.push({
    name: 'logs',
    description: 'Index Claude Code JSONL session logs.',
    defaultEnabled: true,
    triggers: [{ kind: 'timer', intervalMs: logsOverride.intervalMs ?? DEFAULT_LOGS_INTERVAL_MS }],
    async run(ctx) {
      const logsPath = ctx.project.logsPath;
      if (!logsPath) return { message: 'no logsPath configured — skipped' };

      const newerThan = ctx.project.logsNewerThan ? new Date(ctx.project.logsNewerThan) : undefined;
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
  });

  // ── skill:<dir> per agent skill ──────────────────────────────────────────
  for (const dirName of listAvailableSkills()) {
    const def = loadSkillDef(dirName);
    if (!def) continue;
    const jobName = `skill:${dirName}`;
    const override = jobOverrides(config, jobName);
    const triggers: JobTrigger[] = [
      { kind: 'onTypeInsert', typeNames: SKILL_TRIGGER_TYPES },
      { kind: 'timer', intervalMs: override.intervalMs ?? DEFAULT_SKILL_FALLBACK_INTERVAL_MS },
    ];
    jobs.push({
      name: jobName,
      description: def.description,
      defaultEnabled: dirName === 'local-decisions',
      triggers,
      async run(ctx) {
        const initial = (ctx.db.getJobState<SkillJobState>(jobName)) ?? {};
        const processed = new Set<string>(initial.processedEventIds ?? []);

        const r = await runOneSkill({
          db: ctx.db,
          dbPath: ctx.dbPath,
          skillDirName: dirName,
          processedEventIds: processed,
          onBatchProcessed: async (newlyProcessed) => {
            for (const id of newlyProcessed) processed.add(id);
            // Re-read state to preserve any keys the scheduler has updated mid-run.
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
    });
  }

  return jobs;
}
