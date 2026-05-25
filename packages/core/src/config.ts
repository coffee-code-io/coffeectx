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
 *       core: { embed: { provider, model, apiKey, baseUrl, dimensions } }
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
import type { EmbedProvider } from './embed/index.js';

// ── Paths ─────────────────────────────────────────────────────────────────────

export const COFFEECODE_DIR = join(homedir(), '.coffeecode');
export const CONFIG_PATH = join(COFFEECODE_DIR, 'config.yaml');
export const DB_DIR = join(COFFEECODE_DIR, 'db');

// ── Types ─────────────────────────────────────────────────────────────────────

export interface EmbedSettings {
  provider: EmbedProvider;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  /** Target embedding dimension. Defaults to 128. Must match the live DB. */
  dimensions?: number;
}

/**
 * Per-job LLM credentials. Mapped to pi.dev's provider/model selection +
 * runtime auth storage at job-run time by `indexer/src/agentRun/auth.ts`.
 */
export interface AuthSettings {
  /** pi provider id, e.g. 'openai' | 'anthropic' | 'openrouter' | 'google' | 'xai' | … */
  authType?: string;
  /** Provider-specific model id, e.g. 'gpt-4o-mini' or 'claude-sonnet-4-5'. */
  model?: string;
  apiKey?: string;
  /**
   * Optional override of the provider's default base URL. Reserved for
   * future use — pi resolves base URLs from the provider's built-in config
   * today; this field is currently ignored.
   */
  baseUrl?: string;
}

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
}

// ── Defaults ──────────────────────────────────────────────────────────────────

const DEFAULT_EMBED: EmbedSettings = { provider: 'stub', dimensions: 128 };

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

  const types: CoffeectxConfig['types'] = { ...(raw.types ?? {}) };

  return { active: raw.active, projects, types, secrets: raw.secrets };
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

/** Effective embed settings for a project: project.core.embed → defaults. */
export function resolveProjectEmbed(cfg: CoffeectxConfig, projectName: string): EmbedSettings {
  const merged: EmbedSettings = {
    ...DEFAULT_EMBED,
    ...(cfg.projects[projectName]?.core?.embed ?? {}),
  };
  if (!merged.dimensions) merged.dimensions = 128;
  // Env override (cheap escape hatch for development).
  const envProvider = process.env['COFFEECTX_EMBED_PROVIDER'] as EmbedProvider | undefined;
  if (envProvider && ['stub', 'openai', 'openrouter', 'ollama'].includes(envProvider)) {
    merged.provider = envProvider;
  }
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

/** Effective auth for a particular (project, job): only project.jobs[name].parameters.auth. */
export function resolveJobAuth(cfg: CoffeectxConfig, projectName: string, jobName: string): AuthSettings {
  return (cfg.projects[projectName]?.jobs?.[jobName]?.parameters?.['auth'] as AuthSettings | undefined) ?? {};
}

/** Effective auth for the UI agent: project.agent.auth. */
export function resolveAgentAuth(cfg: CoffeectxConfig, projectName: string): AuthSettings {
  return cfg.projects[projectName]?.agent?.auth ?? {};
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
