/**
 * Build the list of jobs the scheduler manages for a given project.
 *
 * Built-in jobs:
 *   - lsp[:<suffix>]    : one per `lsp` / `lsp:*` entry in project.jobs. Reads
 *                         `parameters.{repoPath, lspCommand, intervalMs}`.
 *   - claude            : index Claude Code session JSONLs.
 *   - codex             : index OpenAI Codex CLI sessions from ~/.codex/.
 *   - pi                : index pi.dev session JSONLs from a configured dir.
 *   - plans             : ingest Claude plan-mode markdown files.
 *   - local-decisions   : agent extracts local decisions from new log events;
 *                         prompt at indexer/prompts/local-decisions.md.
 *   - lsp-enrichment    : agent fills in comments on Lsp* symbol nodes;
 *                         prompt at indexer/prompts/lsp-enrichment.md.
 *
 * User skills under `~/.coffeecode/skills/<name>/` that declare a
 * `coffeecode.job` block in their SKILL.md front-matter are also registered
 * here. The skill's directory name is the job name (no prefix).
 */

import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import type { Db, CoffeectxConfig, AuthSettings, Skill, SkillTrigger } from '@coffeectx/core';
import { loadSkillsFromDir, defaultUserSkillsDir } from '@coffeectx/core';
import type { Job, JobTrigger } from './types.js';
import { indexWithLsp } from '../lsp/indexSymbols.js';
import { indexAgentSessions } from '../agentLog/indexLogs.js';
import { ClaudeProvider } from '../agentLog/providers/claude.js';
import { CodexProvider } from '../agentLog/providers/codex.js';
import { PiProvider } from '../agentLog/providers/pi.js';
import { runOneSkill } from '../agentRun/indexAgent.js';
import { loadFileHashes } from '../fileHashes.js';
import { indexPlans } from '../plans/indexPlans.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = resolve(__dirname, '../../prompts');

const DEFAULT_LSP_INTERVAL_MS = 10 * 60_000;
const DEFAULT_AGENTLOG_INTERVAL_MS = 30_000;
const DEFAULT_PLANS_INTERVAL_MS = 5 * 60_000;
const DEFAULT_SKILL_FALLBACK_INTERVAL_MS = 10 * 60_000;
const DEFAULT_LSP_COMMAND = 'typescript-language-server --stdio';
const DEFAULT_PLANS_DIR = join(homedir(), '.claude', 'plans');
const DEFAULT_CODEX_STATE_PATH = join(homedir(), '.codex', 'state_5.sqlite');

/**
 * Event types whose transition to the `linked` state should trigger agent
 * skill jobs. Skill agents need post-LSP enrichment to see Plan/AgentMessage
 * etc. with `relatedSymbols` populated, so jobs fire on the LSP-driven
 * `extracted → linked` bump, not on raw insertion. The fallback timer below
 * is the safety net for state-machine misses.
 */
const SKILL_TRIGGER_TYPES = [
  'UserInput', 'FileOperation', 'ShellExecution',
  'AgentQuestion', 'AgentMessage', 'AgentSummary', 'Plan',
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
  if (typeof v !== 'string' || v.length === 0) return undefined;
  return expandTilde(v);
}

function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
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

function readNewerThan(params: Record<string, unknown>): Date | undefined {
  const v = readString(params, 'newerThan');
  return v ? new Date(v) : undefined;
}

function buildClaudeJob(config: CoffeectxConfig, projectName: string): Job {
  const params = projectJobParams(config, projectName, 'claude');
  return {
    name: 'claude',
    description: 'Index Claude Code JSONL session logs.',
    defaultEnabled: true,
    triggers: [{ kind: 'timer', intervalMs: readIntervalMs(params, DEFAULT_AGENTLOG_INTERVAL_MS) }],
    async run(ctx) {
      const path = readString(ctx.parameters, 'path');
      if (!path) return { message: 'no path configured — skipped' };

      const hashes = loadFileHashes();
      const provider = new ClaudeProvider({ paths: [resolve(path)] });
      const r = await indexAgentSessions(ctx.db, provider, {
        newerThan: readNewerThan(ctx.parameters),
        hashes,
        repoPath: ctx.project.repoPath ?? undefined,
      });

      if (r.errors.length > 0) {
        const first = r.errors[0]!;
        throw new Error(`${r.errors.length} error(s); first: ${first.file}: ${first.error}`);
      }
      return {
        message: `${r.sessions} sessions, ${r.events} events, ${r.inserted} inserted`,
        metrics: { sessions: r.sessions, events: r.events, inserted: r.inserted },
      };
    },
  };
}

function buildCodexJob(config: CoffeectxConfig, projectName: string): Job {
  const params = projectJobParams(config, projectName, 'codex');
  const statePath = readString(params, 'statePath') ?? DEFAULT_CODEX_STATE_PATH;
  // Default-enable iff codex appears to be installed for this user.
  const defaultEnabled = existsSync(statePath);
  return {
    name: 'codex',
    description: 'Index OpenAI Codex CLI sessions from ~/.codex/.',
    defaultEnabled,
    triggers: [{ kind: 'timer', intervalMs: readIntervalMs(params, DEFAULT_AGENTLOG_INTERVAL_MS) }],
    async run(ctx) {
      const sp = readString(ctx.parameters, 'statePath') ?? DEFAULT_CODEX_STATE_PATH;
      if (!existsSync(sp)) return { message: `no codex state at ${sp} — skipped` };

      const provider = new CodexProvider({ statePath: sp });
      const r = await indexAgentSessions(ctx.db, provider, {
        newerThan: readNewerThan(ctx.parameters),
        repoPath: ctx.project.repoPath ?? undefined,
      });

      if (r.errors.length > 0) {
        const first = r.errors[0]!;
        throw new Error(`${r.errors.length} error(s); first: ${first.file}: ${first.error}`);
      }
      return {
        message: `${r.sessions} sessions, ${r.events} events, ${r.inserted} inserted`,
        metrics: { sessions: r.sessions, events: r.events, inserted: r.inserted },
      };
    },
  };
}

function buildPiJob(config: CoffeectxConfig, projectName: string): Job {
  const params = projectJobParams(config, projectName, 'pi');
  return {
    name: 'pi',
    description: 'Index pi.dev session JSONL files from a configured directory.',
    defaultEnabled: false,
    triggers: [{ kind: 'timer', intervalMs: readIntervalMs(params, DEFAULT_AGENTLOG_INTERVAL_MS) }],
    async run(ctx) {
      const sessionsPath = readString(ctx.parameters, 'sessionsPath');
      if (!sessionsPath) return { message: 'no sessionsPath configured — skipped' };

      const provider = new PiProvider({ sessionsPath: resolve(sessionsPath) });
      const r = await indexAgentSessions(ctx.db, provider, {
        newerThan: readNewerThan(ctx.parameters),
        repoPath: ctx.project.repoPath ?? undefined,
      });

      if (r.errors.length > 0) {
        const first = r.errors[0]!;
        throw new Error(`${r.errors.length} error(s); first: ${first.file}: ${first.error}`);
      }
      return {
        message: `${r.sessions} sessions, ${r.events} events, ${r.inserted} inserted`,
        metrics: { sessions: r.sessions, events: r.events, inserted: r.inserted },
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
        message: `${r.scanned} scanned, ${r.inserted} new, ${r.patched} patched (${r.linksAdded} links added), ${r.skipped} unchanged`,
        metrics: {
          scanned: r.scanned,
          inserted: r.inserted,
          patched: r.patched,
          linksAdded: r.linksAdded,
          skipped: r.skipped,
        },
      };
    },
  };
}

/**
 * Generic agent-log skill job builder. Used by the two hardcoded built-ins
 * (`local-decisions`, `lsp-enrichment`) AND by user skills whose body is a
 * SKILL.md and whose triggers match the agent-log linked-state pattern.
 *
 * Shape: every batch is a chunk of new log events grouped by session; the
 * agent's prompt is replayed for each batch and the resulting `$id`-bearing
 * upserts land via `upsertEntries`. Progress is persisted in
 * `jobs.state_json.processedEventIds`.
 */
function buildAgentLogJob(args: {
  name: string;
  description: string;
  prompt: string;
  defaultEnabled: boolean;
  triggers: JobTrigger[];
}): Job {
  const { name, description, prompt, defaultEnabled, triggers } = args;
  return {
    name,
    description,
    defaultEnabled,
    triggers,
    async run(ctx) {
      const initial = (ctx.db.getJobState<SkillJobState>(name)) ?? {};
      const processed = new Set<string>(initial.processedEventIds ?? []);
      const auth = (ctx.parameters['auth'] as AuthSettings | undefined) ?? {};
      const batchStep = typeof ctx.parameters['batchStep'] === 'number'
        ? (ctx.parameters['batchStep'] as number)
        : undefined;
      // Skill jobs write structured knowledge — the agent MUST be able to
      // call upsert_entries. The project's mcp.tools.insert flag only gates
      // the *external* MCP server's exposure to Claude Desktop & friends;
      // the in-process agent is unrelated.
      const allowInsert = true;

      const r = await runOneSkill({
        db: ctx.db,
        projectName: ctx.project.name,
        skillName: name,
        prompt,
        processedEventIds: processed,
        auth,
        batchStep,
        allowInsert,
        signal: ctx.signal,
        onBatchProcessed: async (newlyProcessed) => {
          for (const id of newlyProcessed) processed.add(id);
          const fresh = (ctx.db.getJobState<SkillJobState>(name)) ?? {};
          fresh.processedEventIds = Array.from(processed);
          ctx.db.setJobState(name, fresh);
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

function loadPrompt(file: string): string {
  return readFileSync(join(PROMPTS_DIR, file), 'utf-8');
}

function buildLocalDecisionsJob(config: CoffeectxConfig, projectName: string): Job {
  const params = projectJobParams(config, projectName, 'local-decisions');
  return buildAgentLogJob({
    name: 'local-decisions',
    description: 'Extract local decisions, implementation choices, and concrete change events from agent session events.',
    prompt: loadPrompt('local-decisions.md'),
    defaultEnabled: true,
    triggers: [
      { kind: 'onNodeState', typeNames: SKILL_TRIGGER_TYPES, state: 'linked' },
      { kind: 'timer', intervalMs: readIntervalMs(params, DEFAULT_SKILL_FALLBACK_INTERVAL_MS) },
    ],
  });
}

function buildLspEnrichmentJob(config: CoffeectxConfig, projectName: string): Job {
  const params = projectJobParams(config, projectName, 'lsp-enrichment');
  return buildAgentLogJob({
    name: 'lsp-enrichment',
    description: 'Patch comments onto Lsp* symbol nodes touched by recent file operations.',
    prompt: loadPrompt('lsp-enrichment.md'),
    defaultEnabled: false,
    triggers: [
      { kind: 'onNodeState', typeNames: SKILL_TRIGGER_TYPES, state: 'linked' },
      { kind: 'timer', intervalMs: readIntervalMs(params, DEFAULT_SKILL_FALLBACK_INTERVAL_MS) },
    ],
  });
}

/**
 * Map a skill's coffeecode.job.triggers (Skill-level shape) onto the
 * indexer's JobTrigger shape. Identical fields today — kept as a separate
 * conversion so the indexer can diverge later without touching the core
 * type.
 */
function skillTriggersToJobTriggers(triggers: SkillTrigger[]): JobTrigger[] {
  return triggers.map(t => {
    if (t.kind === 'timer') return { kind: 'timer', intervalMs: t.intervalMs };
    if (t.kind === 'onTypeInsert') return { kind: 'onTypeInsert', typeNames: t.typeNames };
    if (t.kind === 'onNodeState') return { kind: 'onNodeState', typeNames: t.typeNames, state: t.state };
    return { kind: 'cron', expression: t.expression };
  });
}

/**
 * Build a job from a user-installed SKILL.md whose front-matter declares a
 * `coffeecode.job` block. Generic shape: the agent gets the SKILL.md body
 * as its instructions, has full graph-tool access, and runs once per
 * trigger fire. (Unlike the hardcoded built-ins above, we don't feed event
 * batches — the skill body itself decides what to query.)
 *
 * Env vars declared on `skill.requiredEnv` are sourced from
 * `projects.<p>.jobs[<skillName>].env` and exported around `job.run` by
 * the scheduler's `withScopedEnv` wrapper, so we don't need to thread
 * them through here.
 */
function buildUserSkillJob(skill: Skill): Job | null {
  if (!skill.job) return null;
  const triggers = skillTriggersToJobTriggers(skill.job.triggers);
  if (triggers.length === 0) return null;

  return buildAgentLogJob({
    name: skill.name,
    description: skill.description ?? `User skill: ${skill.name}`,
    prompt: skill.body,
    defaultEnabled: skill.job.defaultEnabled ?? false,
    triggers,
  });
}

/**
 * Emit a one-line warning for every required env var on a user skill that
 * isn't provided by the project's job config. Called once at buildJobs().
 */
function warnAboutMissingEnv(skill: Skill, config: CoffeectxConfig, projectName: string): void {
  if (skill.requiredEnv.length === 0) return;
  const envBag = config.projects[projectName]?.jobs?.[skill.name]?.env ?? {};
  const missing = skill.requiredEnv.filter(k => envBag[k] === undefined && process.env[k] === undefined);
  if (missing.length > 0) {
    console.warn(
      `[skills] skill "${skill.name}" requires env [${missing.join(', ')}] ` +
      `but they are not set for project "${projectName}". ` +
      `Add them under projects.${projectName}.jobs.${skill.name}.env in ~/.coffeecode/config.yaml.`,
    );
  }
}

/**
 * Build every job the scheduler knows about for the given project.
 *
 * Loads user skills from `~/.coffeecode/skills/` (or whatever
 * `defaultUserSkillsDir()` resolves to) and registers a job for each that
 * declares `coffeecode.job` in its SKILL.md front-matter.
 */
export function buildJobs(_db: Db, config: CoffeectxConfig, projectName: string): Job[] {
  const jobs: Job[] = [];

  for (const name of discoverLspJobNames(config, projectName)) {
    jobs.push(buildLspJob(name, config, projectName));
  }

  jobs.push(buildClaudeJob(config, projectName));
  jobs.push(buildCodexJob(config, projectName));
  jobs.push(buildPiJob(config, projectName));
  jobs.push(buildPlansJob(config, projectName));
  jobs.push(buildLocalDecisionsJob(config, projectName));
  jobs.push(buildLspEnrichmentJob(config, projectName));

  // User skills. Each skill becomes (at most) one job — those without a
  // `coffeecode.job` block are loaded-only and surface via list_skills.
  const registry = loadSkillsFromDir(defaultUserSkillsDir());
  for (const skill of registry) {
    warnAboutMissingEnv(skill, config, projectName);
    const job = buildUserSkillJob(skill);
    if (job) jobs.push(job);
  }

  // Deprecation nudge for old config keys.
  warnAboutLegacySkillConfigKeys(config, projectName);

  return jobs;
}

function warnAboutLegacySkillConfigKeys(config: CoffeectxConfig, projectName: string): void {
  const jobs = config.projects[projectName]?.jobs ?? {};
  for (const key of Object.keys(jobs)) {
    if (key.startsWith('skill:')) {
      const newKey = key.slice('skill:'.length);
      console.warn(
        `[jobs] config key projects.${projectName}.jobs."${key}" is deprecated; ` +
        `rename to "${newKey}" (the \`skill:\` prefix was dropped when skills moved to ~/.coffeecode/skills/).`,
      );
    }
  }
}
