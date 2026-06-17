/**
 * Unified configuration for coffeectx — read/write ~/.coffeecode/config.yaml.
 *
 * Schema:
 *   active: <name>                          # default --project for CLI
 *   projects:
 *     <name>:
 *       enabled: bool                       # scheduler/MCP serve this project (default: true)
 *       db: <path>
 *       repoPath: <path>                    # for MCP cwd routing + default for LSP jobs
 *       created: <iso-date>
 *       core: { embed: { auth: AuthSettings, dimensions? } }
 *       mcp:  { tools: { search, exact, regex, raw_query, load_node, insert } }
 *       skills: { uiAgent?: {include?,exclude?}, indexingAgents?: {...}, jobs?: {...} }
 *       jobs:
 *         logs:
 *           enabled: bool
 *           parameters: { logsPath, logsNewerThan?, intervalMs? }
 *         lsp[:<suffix>]:                   # one or more LSP jobs per project
 *           enabled: bool
 *           parameters: { repoPath?, lspCommand?, intervalMs? }
 *         local-decisions:                  # hardcoded skill jobs (agent loops over recent events)
 *           enabled: bool
 *           parameters: { auth, batchStep?, intervalMs? }
 *         <user-skill-name>:                # one per ~/.coffeecode/jobs/<dir>/SKILL.md
 *           enabled: bool
 *           env: { VAR: value, ... }        # values for skill's coffeecode.requiredEnv
 *           parameters: { auth, ... }
 *
 *   types: { include, exclude, userDir }    # global type-loading
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve as pathResolve } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { validateAuth, type AuthSettings } from './auth.js';

// ── Paths ─────────────────────────────────────────────────────────────────────

/**
 * Home directory under which `.coffeecode/` lives. Defaults to `$HOME`;
 * overridable via the `COFFEECODE_HOME` env var (useful for tests, sandbox
 * tooling, and machines where the per-user data dir lives off `$HOME`).
 *
 * Resolved once at module load; restart the process to pick up a new value.
 */
export const COFFEECODE_HOME = process.env['COFFEECODE_HOME'] && process.env['COFFEECODE_HOME'].length > 0
  ? process.env['COFFEECODE_HOME']
  : homedir();

export const COFFEECODE_DIR = join(COFFEECODE_HOME, '.coffeecode');
export const CONFIG_PATH = join(COFFEECODE_DIR, 'config.yaml');
export const DB_DIR = join(COFFEECODE_DIR, 'db');

/**
 * Root of Claude Code's per-user state — sessions, plans, settings.
 * Resolved from `$CLAUDE_CONFIG_DIR` if set (matches Claude Code's own
 * convention), defaults to `~/.claude/`. Exported so every reader (init,
 * jobs, test-utils) goes through one resolver instead of hand-rolling
 * `join(homedir(), '.claude', ...)` and drifting when Claude relocates.
 */
export const CLAUDE_DIR = process.env['CLAUDE_CONFIG_DIR'] && process.env['CLAUDE_CONFIG_DIR'].length > 0
  ? process.env['CLAUDE_CONFIG_DIR']
  : join(homedir(), '.claude');

/**
 * Two distinct pi-state locations live in this module — DON'T conflate them:
 *
 *   1. EMBEDDED pi (auth, settings, sessions written by *our* in-process
 *      pi-coding-agent invocations — indexer jobs, UI chat, login flow):
 *      ALWAYS lives under `$COFFEECODE_DIR/.pi/agent/`. Co-located with
 *      coffeectx state so a single `COFFEECODE_HOME` move relocates both,
 *      and an external `PI_CODING_AGENT_DIR` value CANNOT redirect it. We
 *      force `process.env.PI_CODING_AGENT_DIR` to this path at module load
 *      because pi-coding-agent reads that env var to resolve its paths at
 *      call time; the only way to pin embedded state is to clobber the env.
 *
 *   2. EXTERNAL pi (the user's standalone pi CLI installation, whose
 *      session JSONLs the `pi` log-import job ingests): respects the user's
 *      original `$PI_CODING_AGENT_DIR` and falls back to `~/.pi/agent/`.
 *      Captured here BEFORE the override above clobbers it.
 */

const _externalPiRaw = process.env['PI_CODING_AGENT_DIR'];

/** Embedded pi runtime state. Always coffeectx-co-located. */
export const PI_AGENT_DIR = join(COFFEECODE_DIR, '.pi', 'agent');
process.env['PI_CODING_AGENT_DIR'] = PI_AGENT_DIR;

/** External pi installation's state dir — where the user's standalone pi
 *  CLI writes its sessions/. Used by the `pi` log-import job's default
 *  sessions path. */
export const EXTERNAL_PI_AGENT_DIR = _externalPiRaw && _externalPiRaw.length > 0
  ? _externalPiRaw
  : join(homedir(), '.pi', 'agent');

/**
 * Default pi.dev sessions directory for `repoPath` under the EXTERNAL pi
 * installation (NOT the embedded coffeectx-co-located one — embedded pi's
 * own session writes go through pi-coding-agent's `getDefaultSessionDir`,
 * which resolves via `PI_CODING_AGENT_DIR` we pinned above). Encoding
 * matches pi-coding-agent's `getDefaultSessionDir`
 * (`node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js`):
 * strip leading separator, replace remaining `/`, `\\`, `:` with `-`, wrap
 * in `--…--`. Pure function — no fs side effects, unlike pi's own helper
 * which mkdirs on read.
 */
export function defaultPiSessionsDirFor(repoPath: string): string {
  const safe = `--${repoPath.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
  return join(EXTERNAL_PI_AGENT_DIR, 'sessions', safe);
}

/**
 * Root of OpenAI Codex CLI's per-user state — sessions sqlite, rollouts,
 * config. Resolved from `$CODEX_HOME` if set (codex's own convention),
 * defaults to `~/.codex/`. The provider's session sqlite lives at
 * `<CODEX_DIR>/state_5.sqlite`.
 */
export const CODEX_DIR = process.env['CODEX_HOME'] && process.env['CODEX_HOME'].length > 0
  ? process.env['CODEX_HOME']
  : join(homedir(), '.codex');

/** Default location of Codex's session-state sqlite under `CODEX_DIR`. */
export const CODEX_STATE_PATH = join(CODEX_DIR, 'state_5.sqlite');

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Embedding configuration for a project. Auth shape is shared with every
 * other LLM credential block in the config (see {@link AuthSettings}); the
 * only embed-specific knob is `dimensions`.
 *
 * `auth` is optional — when unset, `createEmbedFn` returns a stub that
 * emits zero vectors. Useful for projects that don't want semantic search.
 */
export interface EmbedSettings {
  auth?: AuthSettings;
  /** Target embedding dimension. Defaults to 1536 — matches the native
   *  output of `text-embedding-3-small` (the default model in init). The
   *  value is baked into the sqlite-vec virtual table at DB-create time,
   *  so once the DB exists you cannot change it without rebuilding. */
  dimensions?: number;
}

export type { AuthSettings } from './auth.js';

export interface ToolsSettings {
  search: boolean;
  exact: boolean;
  regex: boolean;
  raw_query: boolean;
  load_node: boolean;
  /** Write access — disabled by default. */
  insert: boolean;
}

export interface JobConfig {
  enabled?: boolean;
  /** Free-form parameters. Conventions: `auth` for jobs needing LLM auth, `intervalMs` for timer override. */
  parameters?: Record<string, unknown>;
  /**
   * Env vars exported into `process.env` for the duration of this job's
   * run. Useful for credentials a skill's scripts read (e.g. Jira tokens,
   * API keys). The scheduler enforces single-job-at-a-time, so scoping via
   * `process.env` snapshot+restore is safe. Skills declare which vars they
   * need via `coffeecode.requiredEnv` in their SKILL.md front-matter — the
   * scheduler warns at startup if a required var isn't set here.
   */
  env?: Record<string, string>;
  /**
   * Trigger override. When present, replaces the SKILL.md
   * `coffeecode.job.triggers` defaults wholesale (no merging — keep the
   * config the source of truth for cron-style jobs the user re-schedules).
   * Shape mirrors `SkillTrigger`; we keep it loosely typed here (`unknown[]`)
   * so the core config schema doesn't depend on the skills module.
   */
  triggers?: unknown[];
}

/**
 * Per-project skill access. Three buckets share the same `{include?,exclude?}`
 * shape; each scopes which skills the matching agent(s) load via pi's
 * ResourceLoader:
 *
 *   - `uiAgent`         — the interactive UI chat agent
 *   - `indexingAgents`  — hardcoded `local-decisions` + `lsp-enrichment`
 *   - `jobs`            — user job-shaped skills (everything in `~/.coffeecode/jobs/`)
 *
 * Visibility rule per (agent, skill):
 *   - if `include` non-empty → visible iff `skill.name ∈ include`
 *   - else                   → visible unless `skill.name ∈ exclude`
 *   - default (no entry)     → all skills visible to that agent
 */
export interface SkillFilter {
  include?: string[];
  exclude?: string[];
}

export type SkillFilterTarget = 'uiAgent' | 'indexingAgents' | 'jobs';

export type ProjectSkillsConfig = {
  [K in SkillFilterTarget]?: SkillFilter;
};

export interface ProjectEntry {
  db: string;
  /** Whether the scheduler/MCP serves this project. Defaults to true on init. */
  enabled?: boolean;
  /**
   * Root of the project on disk. Used by MCP to route by cwd (longest-prefix
   * match) and as the default `repoPath` for any LSP job that doesn't set
   * its own. Doesn't itself trigger LSP indexing.
   */
  repoPath?: string;
  created: string;
  core?: { embed?: EmbedSettings };
  mcp?: { tools?: Partial<ToolsSettings> };
  jobs?: Record<string, JobConfig>;
  /**
   * Per-agent skill visibility. See {@link ProjectSkillsConfig}. When this
   * block is missing every agent in the project sees every loaded skill.
   */
  skills?: ProjectSkillsConfig;
  /**
   * Interactive UI agent — the right-sidebar chat in the webui. Same auth
   * shape as job auth (provider/model/apiKey). When unset, the UI shows a
   * "not configured" hint instead of attempting to spawn a session.
   */
  agent?: { auth?: AuthSettings };
  /**
   * Name of the project entry in `~/.coffeecode/secrets.yaml` that
   * `exec_elevated` should resolve to for this coffeectx project. When unset,
   * defaults to the coffeectx project name itself. Propagated to the pi
   * runtime via `COFFEECTX_SECRETS_PROJECT` env var at session start.
   */
  secretsProject?: string;
}

/** Global secrets integration switch. */
export interface SecretsSettings {
  /**
   * When true, every in-process agent (UI / indexing / user jobs) gets
   * the `exec_elevated` tool from `@coffeectx/secrets-pi` registered as a
   * customTool. The agent must still pass the tool through its own
   * allowlist (user jobs: SKILL.md `allowed-tools`; UI/indexing: hard-
   * coded read-only / DB-writes policies — `exec_elevated` is added but
   * those agents won't see it unless they're configured to). Default: false.
   */
  loadIntoAgents?: boolean;
}

export interface CoffeectxConfig {
  /** Default project name for CLI when --project is omitted. */
  active?: string;
  projects: Record<string, ProjectEntry>;
  /** Builtin/user type loading config (global). */
  types: {
    include?: string[];
    exclude?: string[];
    userDir?: string;
  };
  /** Optional global secrets integration. */
  secrets?: SecretsSettings;
  /**
   * Global debug switch. When true, surfaces normally-hidden diagnostic
   * data (aux-table rows on NodeDetail, etc.) across the UI. Default
   * false. Single boolean today — every consumer just checks
   * `cfg.debug === true`; if we later want per-area toggles this can
   * become `debug?: { ui?: boolean; indexer?: boolean }` without
   * breaking the YAML.
   */
  debug?: boolean;
}

// ── Defaults ──────────────────────────────────────────────────────────────────

const DEFAULT_EMBED: EmbedSettings = { dimensions: 1536 };

const DEFAULT_TOOLS: ToolsSettings = {
  search: true, exact: true, regex: true, raw_query: true,
  load_node: true, insert: false,
};

// ── Raw YAML shape ────────────────────────────────────────────────────────────

type RawConfig = Partial<{
  active: string;
  projects: Record<string, ProjectEntry>;
  types: CoffeectxConfig['types'];
  secrets: SecretsSettings;
  debug: boolean;
}>;

// ── Public API ────────────────────────────────────────────────────────────────

export function loadConfig(): CoffeectxConfig {
  mkdirSync(COFFEECODE_DIR, { recursive: true });

  let raw: RawConfig = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      raw = (parseYaml(readFileSync(CONFIG_PATH, 'utf-8')) as RawConfig | null) ?? {};
    } catch { /* fall through */ }
  }

  const projects = raw.projects ?? {};
  for (const p of Object.values(projects)) {
    if (p.enabled === undefined) p.enabled = true;
  }

  // Strict-validate every auth block. Old-shape configs (missing `authType`
  // or carrying legacy `provider`/`baseUrl` directly on the embed map)
  // throw with a path so the user knows exactly where to edit.
  validateAllAuthBlocks(projects);

  const types: CoffeectxConfig['types'] = { ...(raw.types ?? {}) };

  return { active: raw.active, projects, types, secrets: raw.secrets, debug: raw.debug };
}

/** Walk every auth-bearing path in `projects` and validate the auth shape.
 *  Embed `auth` is optional (stub fallback); when set, it must be valid.
 *  Agent and job-parameter `auth` blocks are likewise optional — but when
 *  present must validate. Skipping silently lets the runtime catch the
 *  problem later with a much worse error message. */
function validateAllAuthBlocks(projects: Record<string, ProjectEntry>): void {
  for (const [pname, p] of Object.entries(projects)) {
    const embedAuth = p.core?.embed?.auth;
    if (embedAuth !== undefined) {
      validateAuth(embedAuth, `projects.${pname}.core.embed.auth`);
    }
    const agentAuth = p.agent?.auth;
    if (agentAuth !== undefined) {
      validateAuth(agentAuth, `projects.${pname}.agent.auth`);
    }
    for (const [jname, job] of Object.entries(p.jobs ?? {})) {
      const jobAuth = job.parameters?.['auth'];
      if (jobAuth !== undefined) {
        validateAuth(jobAuth, `projects.${pname}.jobs.${jname}.parameters.auth`);
      }
    }
  }
}

/** Save the full config back to ~/.coffeecode/config.yaml. */
export function saveConfig(cfg: CoffeectxConfig): void {
  mkdirSync(COFFEECODE_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, stringifyYaml(cfg), 'utf-8');
}

/** Load config, apply a mutation, and save. */
export function updateConfig(fn: (cfg: CoffeectxConfig) => void): CoffeectxConfig {
  const cfg = loadConfig();
  fn(cfg);
  saveConfig(cfg);
  return cfg;
}

// ── Project / settings resolvers ─────────────────────────────────────────────

/** Resolve the db path for a project name (or the active project). */
export function resolveDbPath(cfg: CoffeectxConfig, name?: string): string {
  const projectName = name ?? cfg.active;
  if (projectName && cfg.projects[projectName]) return cfg.projects[projectName]!.db;
  throw new Error(`No db path: project "${projectName ?? '<none>'}" not registered`);
}

export function dbPathForName(name: string): string {
  return join(DB_DIR, `${name}.db`);
}

/** Effective embed settings for a project: project.core.embed → defaults.
 *  `auth` may be missing — `createEmbedFn` falls back to a stub when so. */
export function resolveProjectEmbed(cfg: CoffeectxConfig, projectName: string): EmbedSettings {
  const merged: EmbedSettings = {
    ...DEFAULT_EMBED,
    ...(cfg.projects[projectName]?.core?.embed ?? {}),
  };
  if (!merged.dimensions) merged.dimensions = 1536;
  return merged;
}

/** Effective MCP tool toggles for a project: project.mcp.tools → defaults. */
export function resolveProjectTools(cfg: CoffeectxConfig, projectName: string): ToolsSettings {
  const merged: ToolsSettings = {
    ...DEFAULT_TOOLS,
    ...(cfg.projects[projectName]?.mcp?.tools ?? {}),
  };
  const envInsert = process.env['COFFEECTX_INSERT'];
  if (envInsert === '1' || envInsert === 'true') merged.insert = true;
  return merged;
}

/** Effective auth for a particular (project, job): only project.jobs[name].parameters.auth.
 *  Returns `null` when no auth is configured — callers decide whether that's
 *  fatal (jobs that need an LLM) or fine (jobs that don't). */
export function resolveJobAuth(cfg: CoffeectxConfig, projectName: string, jobName: string): AuthSettings | null {
  return (cfg.projects[projectName]?.jobs?.[jobName]?.parameters?.['auth'] as AuthSettings | undefined) ?? null;
}

/** Effective auth for the UI agent: project.agent.auth. Returns `null` when
 *  unset — the webui shows a "not configured" message in that case. */
export function resolveAgentAuth(cfg: CoffeectxConfig, projectName: string): AuthSettings | null {
  return cfg.projects[projectName]?.agent?.auth ?? null;
}

/** Secrets project name for this coffeectx project — `secretsProject` override or the project name itself. */
export function resolveSecretsProjectName(cfg: CoffeectxConfig, projectName: string): string {
  return cfg.projects[projectName]?.secretsProject ?? projectName;
}

/** Per-job parameters (whole bag) with empty fallback. */
export function resolveJobParameters(cfg: CoffeectxConfig, projectName: string, jobName: string): Record<string, unknown> {
  return cfg.projects[projectName]?.jobs?.[jobName]?.parameters ?? {};
}

/** Per-job env-var map (whole bag) with empty fallback. */
export function resolveJobEnv(cfg: CoffeectxConfig, projectName: string, jobName: string): Record<string, string> {
  return cfg.projects[projectName]?.jobs?.[jobName]?.env ?? {};
}

/** Per-target skill filter (empty {} when nothing is configured). */
export function resolveSkillFilter(
  cfg: CoffeectxConfig,
  projectName: string,
  target: SkillFilterTarget,
): SkillFilter {
  return cfg.projects[projectName]?.skills?.[target] ?? {};
}

/**
 * Filter a list of skill names (or anything with a `.name`) against the
 * configured include/exclude lists for one target.
 */
export function applySkillFilter<T extends { name: string }>(items: ReadonlyArray<T>, filter: SkillFilter): T[] {
  const include = filter.include;
  const exclude = filter.exclude;
  return items.filter(item => {
    if (include && include.length > 0) {
      if (!include.includes(item.name)) return false;
    } else if (exclude && exclude.length > 0) {
      if (exclude.includes(item.name)) return false;
    }
    return true;
  });
}

/** Names of projects with enabled !== false. */
export function listEnabledProjects(cfg: CoffeectxConfig): string[] {
  return Object.entries(cfg.projects)
    .filter(([, p]) => p.enabled !== false)
    .map(([name]) => name);
}

/** Resolve symlinks (e.g. /tmp → /private/tmp on macOS) when possible. */
function canonical(p: string): string {
  try { return realpathSync(p); } catch { return pathResolve(p); }
}

/**
 * Pick the project whose `repoPath` is the longest prefix of `cwd`.
 * Considers only enabled projects. Paths are canonicalized via realpath so
 * symlink differences (e.g. /tmp vs /private/tmp on macOS) don't prevent
 * matches. Returns null if no project matches.
 */
export function resolveProjectByCwd(cfg: CoffeectxConfig, cwd: string): string | null {
  const normalized = canonical(cwd);
  let best: { name: string; length: number } | null = null;
  for (const [name, p] of Object.entries(cfg.projects)) {
    if (p.enabled === false) continue;
    if (!p.repoPath) continue;
    const rp = canonical(p.repoPath);
    if (normalized === rp || normalized.startsWith(rp + '/')) {
      if (!best || rp.length > best.length) best = { name, length: rp.length };
    }
  }
  return best?.name ?? null;
}
