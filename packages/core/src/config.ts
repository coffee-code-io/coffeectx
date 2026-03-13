/**
 * Unified configuration for coffeectx — read/write ~/.coffeecode/config.yaml.
 *
 * This single file replaces the previous split across:
 *   config.yaml   (embed + tools)
 *   projects.yaml (project registry + active pointer)
 *   auth.yaml     (apiKey / baseUrl)
 *   lsp.yaml      (LSP command + servers)
 *
 * Old separate files are still read as fallbacks during migration.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { EmbedProvider } from './embed/index.js';

// ── Paths ─────────────────────────────────────────────────────────────────────

export const COFFEECODE_DIR = join(homedir(), '.coffeecode');
export const CONFIG_PATH = join(COFFEECODE_DIR, 'config.yaml');
export const DB_DIR = join(COFFEECODE_DIR, 'db');

/** Legacy file paths — read as fallback during migration. */
const LEGACY_PROJECTS_PATH = join(COFFEECODE_DIR, 'projects.yaml');
const LEGACY_AUTH_PATH = join(COFFEECODE_DIR, 'auth.yaml');
const LEGACY_LSP_PATH = join(COFFEECODE_DIR, 'lsp.yaml');

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ProjectEntry {
  db: string;
  repoPath?: string;
  /** Path to .claude/projects/<id>/ directory or a specific .jsonl file. */
  logsPath?: string;
  created: string;
}

export interface CoffeectxConfig {
  /** Name of the active project. */
  active?: string;

  /** Per-project entries. */
  projects: Record<string, ProjectEntry>;

  /** Embedding provider configuration. */
  embed: {
    provider: EmbedProvider;
    model?: string;
    baseUrl?: string;
    apiKey?: string;
    /** Target embedding dimension. Defaults to 128. */
    dimensions?: number;
  };

  /** Authentication credentials (merged into embed if embed doesn't specify them). */
  auth?: {
    apiKey?: string;
    baseUrl?: string;
  };

  /** MCP tool toggles. */
  tools: {
    search: boolean;
    exact: boolean;
    regex: boolean;
    raw_query: boolean;
    skills: boolean;
    load_node: boolean;
    /** Write access — disabled by default. */
    insert: boolean;
  };

  /**
   * Builtin type file filtering (by YAML filename stem, e.g. "api", "contract").
   * If `include` is non-empty, only those stems are loaded.
   * `exclude` removes stems from the final set.
   */
  types: {
    include?: string[];
    exclude?: string[];
    /** Directory of user-defined YAML type files. */
    userDir?: string;
  };

  /** Which indexers to run when the `index` command is invoked. */
  indexers: {
    logs: boolean;
    lsp: boolean;
    agent: boolean;
  };

  /** LSP server configuration. */
  lsp: {
    /** Default LSP command (full command string). */
    command: string;
    /** Per-language overrides, e.g. { typescript: "...", python: "..." }. */
    servers?: Record<string, string>;
  };
}

// ── Defaults ──────────────────────────────────────────────────────────────────

const DEFAULTS: CoffeectxConfig = {
  projects: {},
  embed: { provider: 'stub', dimensions: 128 },
  tools: {
    search: true,
    exact: true,
    regex: true,
    raw_query: true,
    skills: true,
    load_node: true,
    insert: false,
  },
  types: {},
  indexers: {
    logs: true,
    lsp: true,
    agent: true,
  },
  lsp: {
    command: 'typescript-language-server --stdio',
  },
};

// ── Raw YAML shape (everything is partial / unknown) ──────────────────────────

type RawConfig = Partial<{
  active: string;
  projects: Record<string, unknown>;
  embed: Record<string, unknown>;
  auth: Record<string, unknown>;
  tools: Record<string, unknown>;
  types: Record<string, unknown>;
  indexers: Record<string, unknown>;
  lsp: Record<string, unknown>;
  // legacy flat db section (config.yaml v1)
  db: Record<string, unknown>;
}>;

// ── Loaders for legacy files ──────────────────────────────────────────────────

function loadLegacyProjects(): { active?: string; projects: Record<string, ProjectEntry> } {
  if (!existsSync(LEGACY_PROJECTS_PATH)) return { projects: {} };
  try {
    const raw = parseYaml(readFileSync(LEGACY_PROJECTS_PATH, 'utf-8')) as {
      active?: string;
      projects?: Record<string, ProjectEntry>;
    } | null;
    return { active: raw?.active, projects: raw?.projects ?? {} };
  } catch {
    return { projects: {} };
  }
}

function loadLegacyAuth(): { apiKey?: string; baseUrl?: string } {
  if (!existsSync(LEGACY_AUTH_PATH)) return {};
  try {
    const parsed = parseYaml(readFileSync(LEGACY_AUTH_PATH, 'utf-8')) as Record<string, unknown> | null;
    const auth = (parsed?.['auth'] as Record<string, unknown> | undefined) ?? (parsed ?? {});
    return {
      apiKey: auth['apiKey'] as string | undefined,
      baseUrl: auth['baseUrl'] as string | undefined,
    };
  } catch {
    return {};
  }
}

function loadLegacyLsp(): { command?: string; servers?: Record<string, string> } {
  if (!existsSync(LEGACY_LSP_PATH)) return {};
  try {
    const parsed = parseYaml(readFileSync(LEGACY_LSP_PATH, 'utf-8')) as Record<string, unknown> | null;
    if (!parsed) return {};
    const command =
      (parsed['default'] as string | undefined) ??
      (parsed['command'] as string | undefined);
    const servers = parsed['servers'] as Record<string, string> | undefined;
    return { command: command?.trim() || undefined, servers };
  } catch {
    return {};
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Load the unified config. Falls back to legacy separate files during migration. */
export function loadConfig(): CoffeectxConfig {
  mkdirSync(COFFEECODE_DIR, { recursive: true });

  let raw: RawConfig = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      raw = (parseYaml(readFileSync(CONFIG_PATH, 'utf-8')) as RawConfig | null) ?? {};
    } catch { /* fall through */ }
  }

  // ── Embed ───────────────────────────────────────────────────────────────────
  const embed: CoffeectxConfig['embed'] = {
    ...DEFAULTS.embed,
    ...(raw.embed as Partial<CoffeectxConfig['embed']> | undefined),
  };

  // legacy flat db.path → ignored here, handled separately via active project
  // legacy embed dimensions fallback
  if (!embed.dimensions) embed.dimensions = 128;

  // ── Auth — merge into embed if not already set ──────────────────────────────
  const auth = (raw.auth as { apiKey?: string; baseUrl?: string } | undefined) ?? {};
  if (!auth.apiKey && !embed.apiKey) {
    const legacy = loadLegacyAuth();
    if (legacy.apiKey) auth.apiKey = legacy.apiKey;
    if (legacy.baseUrl && !auth.baseUrl) auth.baseUrl = legacy.baseUrl;
  }
  if (auth.apiKey && !embed.apiKey) embed.apiKey = auth.apiKey;
  if (auth.baseUrl && !embed.baseUrl) embed.baseUrl = auth.baseUrl;

  // ── Projects — merge from legacy projects.yaml if not in main config ────────
  let projects = (raw.projects ?? {}) as Record<string, ProjectEntry>;
  let active = raw.active;
  if (Object.keys(projects).length === 0) {
    const legacy = loadLegacyProjects();
    if (Object.keys(legacy.projects).length > 0) {
      projects = legacy.projects;
      active ??= legacy.active;
    }
  }

  // ── LSP — merge from legacy lsp.yaml ───────────────────────────────────────
  const rawLsp = (raw.lsp as Partial<CoffeectxConfig['lsp']> | undefined) ?? {};
  const legacyLsp = loadLegacyLsp();
  const lsp: CoffeectxConfig['lsp'] = {
    command: rawLsp.command ?? legacyLsp.command ?? DEFAULTS.lsp.command,
    servers: rawLsp.servers ?? legacyLsp.servers,
  };

  // ── Tools ───────────────────────────────────────────────────────────────────
  const tools: CoffeectxConfig['tools'] = {
    ...DEFAULTS.tools,
    ...(raw.tools as Partial<CoffeectxConfig['tools']> | undefined),
  };

  // ── Types ───────────────────────────────────────────────────────────────────
  const types: CoffeectxConfig['types'] = {
    ...DEFAULTS.types,
    ...(raw.types as Partial<CoffeectxConfig['types']> | undefined),
  };

  // ── Indexers ─────────────────────────────────────────────────────────────────
  const indexers: CoffeectxConfig['indexers'] = {
    ...DEFAULTS.indexers,
    ...(raw.indexers as Partial<CoffeectxConfig['indexers']> | undefined),
  };

  // ── Environment variable overrides ──────────────────────────────────────────
  const envProvider = process.env['COFFEECTX_EMBED_PROVIDER'] as EmbedProvider | undefined;
  if (envProvider && ['stub', 'openai', 'openrouter', 'ollama'].includes(envProvider)) {
    embed.provider = envProvider;
  }
  const envInsert = process.env['COFFEECTX_INSERT'];
  if (envInsert === '1' || envInsert === 'true') tools.insert = true;

  const cfg: CoffeectxConfig = { active, projects, embed, auth, tools, types, indexers, lsp };

  return cfg;
}

/** Save the full config back to ~/.coffeecode/config.yaml. */
export function saveConfig(cfg: CoffeectxConfig): void {
  mkdirSync(COFFEECODE_DIR, { recursive: true });
  // Don't persist env-only credentials
  writeFileSync(CONFIG_PATH, stringifyYaml(cfg), 'utf-8');
}

/** Load config, apply a mutation, and save. */
export function updateConfig(fn: (cfg: CoffeectxConfig) => void): CoffeectxConfig {
  const cfg = loadConfig();
  fn(cfg);
  saveConfig(cfg);
  return cfg;
}

/** Resolve the db path for a given project name (or the active project). */
export function resolveDbPath(cfg: CoffeectxConfig, name?: string): string {
  const projectName = name ?? cfg.active;
  if (projectName && cfg.projects[projectName]) {
    return cfg.projects[projectName]!.db;
  }
  // Legacy fallback: flat db.path in old config.yaml
  const raw = existsSync(CONFIG_PATH)
    ? ((parseYaml(readFileSync(CONFIG_PATH, 'utf-8')) as Record<string, unknown> | null) ?? {})
    : {};
  const legacyDb = (raw['db'] as Record<string, unknown> | undefined)?.['path'] as string | undefined;
  return legacyDb ?? join(COFFEECODE_DIR, 'retrival.db');
}

export function dbPathForName(name: string): string {
  return join(DB_DIR, `${name}.db`);
}
