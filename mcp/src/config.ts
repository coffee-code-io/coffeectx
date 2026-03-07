import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';

export interface Config {
  db: {
    path: string;
  };
  embed: {
    provider: 'stub' | 'openai' | 'ollama';
    model?: string;
    baseUrl?: string;
    apiKey?: string;
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

export function loadConfig(): Config {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });

  if (!existsSync(CONFIG_PATH)) {
    return DEFAULTS;
  }

  const raw = readFileSync(CONFIG_PATH, 'utf-8');
  const parsed = parse(raw) as Partial<Config> | null;
  if (!parsed) return DEFAULTS;

  return {
    db: { ...DEFAULTS.db, ...parsed.db },
    embed: { ...DEFAULTS.embed, ...parsed.embed },
    tools: { ...DEFAULTS.tools, ...parsed.tools },
  };
}
