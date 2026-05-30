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
import { loadAllSkills, parseTriggers } from '@coffeectx/core';
import { runUserJob } from '../agentRun/runUserJob.js';
import type { Job, JobTrigger } from './types.js';
import { indexWithLsp } from '../lsp/indexSymbols.js';
import { indexAgentSessions } from '../agentLog/indexLogs.js';
import { linkSpans } from '../agentLog/spanLink.js';
import { ClaudeProvider } from '../agentLog/providers/claude.js';
import { CodexProvider } from '../agentLog/providers/codex.js';
import { PiProvider } from '../agentLog/providers/pi.js';
import { runOneSkill } from '../agentRun/indexAgent.js';
import { loadFileHashes } from '../fileHashes.js';
import { indexPlans } from '../plans/indexPlans.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = resolve(__dirname, '../../prompts');

const DEFAULT_AGENTLOG_INTERVAL_MS = 30_000;
const DEFAULT_PLANS_INTERVAL_MS = 5 * 60_000;
const DEFAULT_SKILL_FALLBACK_INTERVAL_MS = 10 * 60_000;
const DEFAULT_LSP_COMMAND = 'typescript-language-server --stdio';
const DEFAULT_PLANS_DIR = join(homedir(), '.claude', 'plans');
const DEFAULT_CODEX_STATE_PATH = join(homedir(), '.codex', 'state_5.sqlite');

/**
 * Named types whose transition to the `linked` state should fan out to the
 * indexing skill jobs (`local-decisions`, `lsp-enrichment`). Per-event
 * agent-log types are out — they no longer carry a state machine, since
 * symbol attribution now happens at the Span level. Spans + Plans are the
 * only kinds that travel `extracted → linked`. The fallback timer on each
 * job is the safety net for state-machine misses.
 */
const SKILL_TRIGGER_TYPES = ['Span', 'Plan'];

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

interface LspJobState {
  /** High-water mark — snapshot ts already consumed. */
  lastConsumedTs?: number;
}

function buildLspJob(jobName: string, _config: CoffeectxConfig, _projectName: string): Job {
  return {
    name: jobName,
    description: 'Index repository source files via Language Server Protocol.',
    defaultEnabled: false,
    // LSP extraction is gated by closed Spans — when a Span flips to
    // `extracted`, every file whose latest snapshot is ≤ that span's
    // `endedAt` gets one symbol-extraction pass. Snapshots after the
    // cutoff (in-progress conversations) defer to the next span close.
    // For bootstrap (no spans yet) the user triggers manually.
    triggers: [{ kind: 'onNodeState', typeNames: ['Span'], state: 'extracted' }],
    async run(ctx) {
      const repoPath = readString(ctx.parameters, 'repoPath') ?? ctx.project.repoPath;
      if (!repoPath) return { message: 'no repoPath configured — skipped' };

      const lspCmd = readString(ctx.parameters, 'lspCommand') ?? DEFAULT_LSP_COMMAND;
      const [lspBin, ...lspArgs] = lspCmd.trim().split(/\s+/).filter(Boolean);
      if (!lspBin) throw new Error(`invalid lspCommand: "${lspCmd}"`);
      const lspBinPath = lspBin.startsWith('~/') ? `${homedir()}/${lspBin.slice(2)}` : lspBin;

      const state = (ctx.db.getJobState<LspJobState>(jobName)) ?? {};
      const cutoffMs = ctx.db.getMaxClosedSpanEndedAt();
      const r = await indexWithLsp(ctx.db, resolve(repoPath), lspBinPath, lspArgs, {
        supervisor: ctx.snapshotSupervisor,
        lastConsumedTs: state.lastConsumedTs ?? 0,
        cutoffMs: cutoffMs ?? undefined,
      });

      if (r.consumedTs !== undefined && r.consumedTs > (state.lastConsumedTs ?? 0)) {
        ctx.db.setJobState(jobName, { ...state, lastConsumedTs: r.consumedTs });
      }

      if (r.skipped) return { message: 'no source files changed' };
      if (r.errors.length > 0) {
        const first = r.errors[0]!;
        throw new Error(`${r.errors.length} file error(s); first: ${first.file}: ${first.error}`);
      }
      return {
        message: `${r.files} files, ${r.nodes} new, ${r.bumped} bumped, ${r.deleted} deleted`,
        metrics: { files: r.files, nodes: r.nodes, bumped: r.bumped, deleted: r.deleted },
      };
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
    defaultEnabled: false,
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
  return {
    name: 'codex',
    description: 'Index OpenAI Codex CLI sessions from ~/.codex/.',
    // Every job now defaults to off — being in config.yaml is the explicit
    // signal that the user wants this job running.
    defaultEnabled: false,
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
    defaultEnabled: false,
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
    defaultEnabled: false,
    triggers: [
      { kind: 'onNodeState', typeNames: SKILL_TRIGGER_TYPES, state: 'linked' },
      { kind: 'timer', intervalMs: readIntervalMs(params, DEFAULT_SKILL_FALLBACK_INTERVAL_MS) },
    ],
  });
}

function buildSpanLinkJob(): Job {
  return {
    name: 'span-link',
    description: 'Link Spans to LSP symbols based on filesChanged at endedAt.',
    // Every system job defaults to disabled — the project's config.yaml is
    // the source of truth. The UI surfaces a warning when system jobs are
    // off so the user knows to turn them on. Later: project init flips all
    // system jobs to enabled automatically.
    defaultEnabled: false,
    triggers: [
      { kind: 'onNodeState', typeNames: ['Span'], state: 'extracted' },
      // Fallback timer so a missed state-change still gets caught up.
      { kind: 'timer', intervalMs: DEFAULT_SKILL_FALLBACK_INTERVAL_MS },
    ],
    async run(ctx) {
      const r = await linkSpans(ctx.db);
      if (r.errors.length > 0) {
        const first = r.errors[0]!;
        throw new Error(`${r.errors.length} span error(s); first: ${first.spanId}: ${first.error}`);
      }
      return {
        message: `${r.scanned} scanned, ${r.linked} linked, ${r.symbols} symbol refs`,
        metrics: { scanned: r.scanned, linked: r.linked, symbols: r.symbols },
      };
    },
  };
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
 * Build a job from a user-installed SKILL.md (anything under
 * `~/.coffeecode/jobs/<name>/`). Triggers come from (priority order):
 *   1. `projects.<p>.jobs[<name>].triggers` in config.yaml (full override)
 *   2. `coffeecode.job.triggers` in the SKILL.md front-matter
 *
 * If neither produces any triggers, the job is registered as manual-only —
 * it appears in `job list` / the Jobs UI and only fires on explicit
 * Trigger clicks.
 *
 * The agent itself is run fresh by `runUserJob`: a new pi session per
 * trigger fire, SKILL.md body delivered as a single prompt, graph + file
 * tools available, agent loops autonomously until `agent_end`. No event
 * batching, no `processedEventIds` state — the skill decides what to
 * query.
 *
 * Env vars declared on `skill.requiredEnv` are sourced from
 * `projects.<p>.jobs[<name>].env` and exported around `job.run` by the
 * scheduler's `withScopedEnv` wrapper, so the agent (and any child
 * processes it spawns) sees them via `process.env`.
 */
function buildUserSkillJob(skill: Skill, config: CoffeectxConfig, projectName: string): Job | null {
  if (skill.category !== 'job') return null;
  const triggers = resolveJobTriggers(skill, config, projectName);
  return {
    name: skill.name,
    description: skill.description ?? `User skill: ${skill.name}`,
    defaultEnabled: skill.job?.defaultEnabled ?? false,
    triggers,
    async run(ctx) {
      const auth = (ctx.parameters['auth'] as AuthSettings | undefined) ?? {};
      const r = await runUserJob({
        db: ctx.db,
        jobName: skill.name,
        projectName: ctx.project.name,
        prompt: skill.body,
        auth,
        requiredEnv: skill.requiredEnv,
        allowedTools: skill.allowedTools,
        signal: ctx.signal,
      });
      return {
        message: r.sessionFile ? `session ${r.sessionFile}` : 'done',
      };
    },
  };
}

/**
 * Pick the effective trigger list for a user job — config override wins,
 * SKILL.md is the fallback, empty array means "manual only".
 */
function resolveJobTriggers(skill: Skill, config: CoffeectxConfig, projectName: string): JobTrigger[] {
  const override = config.projects[projectName]?.jobs?.[skill.name]?.triggers;
  if (Array.isArray(override) && override.length > 0) {
    return skillTriggersToJobTriggers(parseTriggers(override));
  }
  return skill.job ? skillTriggersToJobTriggers(skill.job.triggers) : [];
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
  jobs.push(buildSpanLinkJob());

  // User skills + jobs. Skills from `~/.coffeecode/skills/` are
  // agent-loadable only (no job registration here — pi's ResourceLoader
  // surfaces them inside each agent run). Items under
  // `~/.coffeecode/jobs/` are tagged `category: 'job'` and become
  // scheduler jobs.
  const registry = loadAllSkills();
  for (const skill of registry) {
    if (skill.category !== 'job') continue;
    warnAboutMissingEnv(skill, config, projectName);
    const job = buildUserSkillJob(skill, config, projectName);
    if (job) jobs.push(job);
  }

  return jobs;
}
