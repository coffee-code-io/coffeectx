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
 *       mcp:  { tools: { search, exact, regex, raw_query, skills, load_node, insert } }
 *       jobs:
 *         logs:
 *           enabled: bool
 *           parameters: { logsPath, logsNewerThan?, intervalMs? }
 *         lsp[:<suffix>]:                   # one or more LSP jobs per project
 *           enabled: bool
 *           parameters: { repoPath?, lspCommand?, intervalMs? }
 *         skill:<dirName>:
 *           enabled: bool
 *           parameters: { auth, batchStep?, intervalMs? }
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

export interface AuthSettings {
  authType?: 'openai' | 'anthropic' | 'qwen-oauth' | 'gemini' | 'vertex-ai';
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  /** Absolute path to a qwen CLI executable; overrides the auto-resolved packaged default. */
  qwenPath?: string;
}

export interface ToolsSettings {
  search: boolean;
  exact: boolean;
  regex: boolean;
  raw_query: boolean;
  skills: boolean;
  load_node: boolean;
  /** Write access — disabled by default. */
  insert: boolean;
}

export interface JobConfig {
  enabled?: boolean;
  /** Free-form parameters. Conventions: `auth` for jobs needing LLM auth, `intervalMs` for timer override. */
  parameters?: Record<string, unknown>;
}

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
}

// ── Defaults ──────────────────────────────────────────────────────────────────

const DEFAULT_EMBED: EmbedSettings = { provider: 'stub', dimensions: 128 };

const DEFAULT_TOOLS: ToolsSettings = {
  search: true, exact: true, regex: true, raw_query: true,
  skills: true, load_node: true, insert: false,
};

// ── Raw YAML shape ────────────────────────────────────────────────────────────

type RawConfig = Partial<{
  active: string;
  projects: Record<string, ProjectEntry>;
  types: CoffeectxConfig['types'];
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

  return { active: raw.active, projects, types };
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

/** Per-job parameters (whole bag) with empty fallback. */
export function resolveJobParameters(cfg: CoffeectxConfig, projectName: string, jobName: string): Record<string, unknown> {
  return cfg.projects[projectName]?.jobs?.[jobName]?.parameters ?? {};
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
