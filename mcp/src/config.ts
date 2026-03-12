import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { EmbedProvider } from '@coffeectx/core';

export interface Config {
  db: {
    path: string;
  };
  embed: {
    provider: EmbedProvider;
    model?: string;
    baseUrl?: string;
    apiKey?: string;
    /** Target embedding dimension. Defaults to 1536. */
    dimensions?: number;
  };
  tools: {
    search: boolean;    // semantic similarity search
    exact: boolean;     // exact symbol match
    regex: boolean;     // regex symbol match
    raw_query: boolean;
    skills: boolean;    // list_skills / get_skill
    load_node: boolean; // load node by ID with depth control
    insert: boolean;    // write access — disabled by default
  };
}

const CONFIG_DIR = join(homedir(), '.coffeecode');
const CONFIG_PATH = join(CONFIG_DIR, 'config.yaml');
const AUTH_PATH = join(CONFIG_DIR, 'auth.yaml');

const DEFAULTS: Config = {
  db: {
    path: join(CONFIG_DIR, 'retrival.db'),
  },
  embed: {
    provider: 'stub',
  },
  tools: {
    search: true,
    exact: true,
    regex: true,
    raw_query: true,
    skills: true,
    load_node: true,
    insert: false,
  },
};

interface AuthYaml {
  apiKey?: string;
  baseUrl?: string;
}

function loadAuthYaml(): AuthYaml {
  if (!existsSync(AUTH_PATH)) return {};
  try {
    const parsed = (parse(readFileSync(AUTH_PATH, 'utf-8')) as Record<string, unknown>) ?? {};
    // Support both flat { apiKey, ... } and nested { auth: { apiKey, ... } }
    return ((parsed['auth'] as AuthYaml | undefined) ?? (parsed as AuthYaml)) ?? {};
  } catch {
    return {};
  }
}

export function loadConfig(): Config {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });

  let config: Config;
  if (!existsSync(CONFIG_PATH)) {
    config = { ...DEFAULTS, db: { ...DEFAULTS.db }, embed: { ...DEFAULTS.embed }, tools: { ...DEFAULTS.tools } };
  } else {
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    const parsed = parse(raw) as Partial<Config> | null;
    if (!parsed) {
      config = { ...DEFAULTS, db: { ...DEFAULTS.db }, embed: { ...DEFAULTS.embed }, tools: { ...DEFAULTS.tools } };
    } else {
      config = {
        db: { ...DEFAULTS.db, ...parsed.db },
        embed: { ...DEFAULTS.embed, ...parsed.embed },
        tools: { ...DEFAULTS.tools, ...parsed.tools },
      };
    }
  }

  // Environment variable overrides (used by agent subprocesses to point at a
  // specific project DB and enable insert access without editing config.yaml).
  const envDbPath = process.env['RETRIVAL_DB_PATH'];
  if (envDbPath) config.db.path = envDbPath;

  const envInsert = process.env['RETRIVAL_INSERT'];
  if (envInsert === '1' || envInsert === 'true') config.tools.insert = true;

  const envProvider = process.env['RETRIVAL_EMBED_PROVIDER'] as EmbedProvider | undefined;
  if (envProvider && ['stub', 'openai', 'openrouter', 'ollama'].includes(envProvider)) {
    config.embed.provider = envProvider;
  }

  // Fall back to auth.yaml credentials if embed section doesn't specify them.
  // This way setting up auth.yaml once covers both LLM and embedding calls.
  if (!config.embed.apiKey) {
    const auth = loadAuthYaml();
    if (auth.apiKey) config.embed.apiKey = auth.apiKey;
    if (auth.baseUrl && !config.embed.baseUrl) config.embed.baseUrl = auth.baseUrl;
  }

  return config;
}
