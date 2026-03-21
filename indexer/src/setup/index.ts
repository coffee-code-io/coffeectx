#!/usr/bin/env node
/**
 * Interactive postinstall setup wizard for coffeectx.
 *
 * Runs automatically after `npm install` when stdin is a TTY.
 * Set COFFEECTX_SKIP_SETUP=1 to suppress.
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { ask, confirm, choose, close } from './prompt.js';
import { isDaemonSupported, installDaemon } from './daemon.js';
import { registerMcpClaudeDesktop, appendClaudeMd, getMcpServerBin } from './claude.js';

// ── Guards ────────────────────────────────────────────────────────────────────

if (!process.stdin.isTTY || process.env['COFFEECTX_SKIP_SETUP'] === '1') {
  process.exit(0);
}

// ── Constants ─────────────────────────────────────────────────────────────────

const COFFEECODE_DIR = join(homedir(), '.coffeecode');
const CONFIG_PATH = join(COFFEECODE_DIR, 'config.yaml');
const DB_DIR = join(COFFEECODE_DIR, 'db');
const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects');

// ── Banner ────────────────────────────────────────────────────────────────────

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const CYAN = '\x1b[36m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';

function banner(): void {
  console.log('');
  console.log(`${BOLD}${CYAN}  ██████╗ ██████╗ ███████╗███████╗███████╗███████╗${RESET}`);
  console.log(`${BOLD}${CYAN} ██╔════╝██╔═══██╗██╔════╝██╔════╝██╔════╝██╔════╝${RESET}`);
  console.log(`${BOLD}${CYAN} ██║     ██║   ██║█████╗  █████╗  █████╗  █████╗  ${RESET}`);
  console.log(`${BOLD}${CYAN} ██║     ██║   ██║██╔══╝  ██╔══╝  ██╔══╝  ██╔══╝  ${RESET}`);
  console.log(`${BOLD}${CYAN} ╚██████╗╚██████╔╝██║     ██║     ███████╗███████╗${RESET}`);
  console.log(`${BOLD}${CYAN}  ╚═════╝ ╚═════╝ ╚═╝     ╚═╝     ╚══════╝╚══════╝${RESET}`);
  console.log('');
  console.log(`${BOLD}  CoffeeCtx Setup${RESET}  ${DIM}— knowledge graph indexer for coding agents${RESET}`);
  console.log('');
}

// ── Provider / model definitions ──────────────────────────────────────────────

const PROVIDERS = ['OpenRouter', 'OpenAI', 'Anthropic'] as const;
type Provider = (typeof PROVIDERS)[number];

const MODELS: Record<Provider, string[]> = {
  OpenRouter: [
    'qwen/qwen3-32b',
    'anthropic/claude-opus-4',
    'openai/gpt-4o',
    'google/gemini-2.0-flash',
  ],
  OpenAI: ['gpt-4o', 'gpt-4o-mini', 'o1'],
  Anthropic: ['claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5'],
};

const EMBED_MODELS: Record<Provider, string[]> = {
  OpenRouter: ['openai/text-embedding-3-small', 'openai/text-embedding-3-large'],
  OpenAI: ['text-embedding-3-small', 'text-embedding-3-large'],
  Anthropic: ['text-embedding-3-small', 'text-embedding-3-large'],
};

const API_KEY_HINTS: Record<Provider, string> = {
  OpenRouter: 'Get your key at: https://openrouter.ai/keys',
  OpenAI: 'Get your key at: https://platform.openai.com/api-keys',
  Anthropic: 'Get your key at: https://console.anthropic.com',
};

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

// ── Claude projects scanning ──────────────────────────────────────────────────

interface ProjectSetup {
  name: string;
  repoPath: string;
  logsPath: string;
  logsNewerThan?: string;
}

/**
 * Convert a Claude project directory name to a best-guess repo path.
 * The dir name looks like "-Users-dima-Documents-myrepo", which maps to
 * /Users/dima/Documents/myrepo.
 */
function dirNameToRepoPath(dirName: string): string {
  // Replace each segment separator: leading '-' → '/', then '-' between segments.
  // Strategy: the dir name uses '-' in place of '/', and the path starts with '/'.
  // e.g. "-Users-dima-Documents-my-project" → "/Users/dima/Documents/my-project"
  // We can't distinguish '-' in the path from '-' as separator, so we just
  // replace the leading '-' with '/' and leave the rest for the user to correct.
  if (dirName.startsWith('-')) {
    return '/' + dirName.slice(1).replace(/-/g, '/');
  }
  return dirName;
}

async function gatherProjects(): Promise<ProjectSetup[]> {
  const projects: ProjectSetup[] = [];

  if (existsSync(CLAUDE_PROJECTS_DIR)) {
    let dirs: string[] = [];
    try {
      dirs = readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);
    } catch {
      // ignore read errors
    }

    if (dirs.length > 0) {
      console.log(`\n${BOLD}Found ${dirs.length} Claude project director${dirs.length === 1 ? 'y' : 'ies'}:${RESET}`);

      for (const dirName of dirs) {
        const logsPath = join(CLAUDE_PROJECTS_DIR, dirName);
        const guessedRepo = dirNameToRepoPath(dirName);

        console.log(`\n${DIM}  Claude dir: ${logsPath}${RESET}`);

        const repoPath = await ask(
          `  Repo path for "${dirName}"?`,
          guessedRepo,
        );

        if (!repoPath) {
          console.log(`  ${DIM}Skipping (no repo path).${RESET}`);
          continue;
        }

        const defaultName = basename(repoPath);
        const name = await ask(`  Project name?`, defaultName);

        if (!name) {
          console.log(`  ${DIM}Skipping (no project name).${RESET}`);
          continue;
        }

        const newerThan = await ask(
          `  Only index sessions newer than (ISO date, optional)`,
          '',
        );

        projects.push({
          name: sanitizeName(name),
          repoPath,
          logsPath,
          logsNewerThan: newerThan || undefined,
        });
      }
    }
  }

  if (projects.length === 0) {
    console.log(`\n${YELLOW}No Claude project directories found (or none configured).${RESET}`);
    console.log('You can enter the paths manually.\n');

    const logsPath = await ask('Path to Claude logs directory (or leave empty to skip)', '');
    const repoPath = await ask('Path to your project repo (or leave empty to skip)', '');

    if (logsPath || repoPath) {
      const defaultName = repoPath ? basename(repoPath) : 'default';
      const name = await ask('Project name', defaultName);
      const newerThan = await ask(
        'Only index sessions newer than (ISO date, optional)',
        '',
      );
      if (name) {
        projects.push({
          name: sanitizeName(name),
          repoPath: repoPath || '',
          logsPath: logsPath || '',
          logsNewerThan: newerThan || undefined,
        });
      }
    }
  }

  return projects;
}

// ── Name sanitizer (mirrors projects.ts) ─────────────────────────────────────

function sanitizeName(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_|_$/g, '');
}

// ── Config writer ─────────────────────────────────────────────────────────────

interface AuthConfig {
  authType: 'openai' | 'anthropic';
  apiKey: string;
  model: string;
  baseUrl?: string;
}

interface EmbedConfig {
  provider: string;
  model: string;
  apiKey: string;
  baseUrl?: string;
}

function buildConfig(
  projects: ProjectSetup[],
  auth: AuthConfig,
  embed: EmbedConfig,
): Record<string, unknown> {
  const projectEntries: Record<string, unknown> = {};

  for (const p of projects) {
    const entry: Record<string, unknown> = {
      db: join(DB_DIR, `${p.name}.db`),
      created: new Date().toISOString(),
    };
    if (p.repoPath) entry['repoPath'] = p.repoPath;
    if (p.logsPath) entry['logsPath'] = p.logsPath;
    if (p.logsNewerThan) entry['logsNewerThan'] = p.logsNewerThan;
    projectEntries[p.name] = entry;
  }

  const cfg: Record<string, unknown> = {
    active: projects[0]?.name,
    projects: projectEntries,
    tools: {
      search: true,
      exact: true,
      regex: true,
      raw_query: true,
      skills: true,
      load_node: true,
      insert: false,
    },
    types: {
      include: [],
      exclude: [],
      userDir: null,
    },
    indexers: {
      lsp: false,
      logs: true,
      agent: true,
    },
    agent: {
      skills: {
        'local-decisions': true,
        'lsp-enrichment': false,
      },
    },
    auth: {
      authType: auth.authType,
      apiKey: auth.apiKey,
      model: auth.model,
      ...(auth.baseUrl ? { baseUrl: auth.baseUrl } : {}),
    },
    embed: {
      provider: embed.provider,
      model: embed.model,
      apiKey: embed.apiKey,
      ...(embed.baseUrl ? { baseUrl: embed.baseUrl } : {}),
    },
  };

  return cfg;
}

// ── Resolve the indexer bin path ──────────────────────────────────────────────

function getIndexerBin(): string {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  // This file compiles to dist/setup/index.js; the indexer entry is dist/index.js
  return join(__dirname, '..', 'index.js');
}

// ── Main wizard ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  banner();

  // ── Existing config check ─────────────────────────────────────────────────

  if (existsSync(CONFIG_PATH)) {
    const reconfigure = await confirm(
      'Config already exists — reconfigure?',
      false,
    );
    if (!reconfigure) {
      console.log(`\n${GREEN}Setup skipped. Existing config preserved.${RESET}`);
      close();
      process.exit(0);
    }
    console.log('');
  }

  // ── Auth setup ────────────────────────────────────────────────────────────

  console.log(`${BOLD}Step 1: Authentication${RESET}`);

  const providerName = await choose('Choose your LLM provider:', [...PROVIDERS]) as Provider;
  const models = MODELS[providerName];

  console.log(`\n  ${DIM}${API_KEY_HINTS[providerName]}${RESET}`);
  let apiKey = '';
  while (!apiKey) {
    apiKey = await ask(`  ${providerName} API key`);
    if (!apiKey) console.log('  API key cannot be empty.');
  }

  const model = await choose(`Choose a ${providerName} model:`, models);
  const embedModel = await choose(`Choose an embedding model:`, EMBED_MODELS[providerName]);

  const authType: 'openai' | 'anthropic' =
    providerName === 'Anthropic' ? 'anthropic' : 'openai';

  const auth: AuthConfig = {
    authType,
    apiKey,
    model,
    ...(providerName === 'OpenRouter' ? { baseUrl: OPENROUTER_BASE_URL } : {}),
  };

  const embedProvider = providerName === 'OpenRouter' ? 'openrouter' : 'openai';
  const embed: EmbedConfig = {
    provider: embedProvider,
    model: embedModel,
    apiKey,
    ...(providerName === 'OpenRouter' ? { baseUrl: OPENROUTER_BASE_URL } : {}),
  };

  // ── Project setup ─────────────────────────────────────────────────────────

  console.log(`\n${BOLD}Step 2: Project Setup${RESET}`);

  const projects = await gatherProjects();

  // ── Write config ──────────────────────────────────────────────────────────

  console.log(`\n${BOLD}Step 3: Writing Config${RESET}`);

  mkdirSync(COFFEECODE_DIR, { recursive: true });
  mkdirSync(DB_DIR, { recursive: true });

  const cfg = buildConfig(projects, auth, embed);
  const yaml = stringifyYaml(cfg, { lineWidth: 0 });
  writeFileSync(CONFIG_PATH, yaml, 'utf-8');
  console.log(`  ${GREEN}Written:${RESET} ${CONFIG_PATH}`);

  // Sync builtin types (best-effort)
  const indexerBin = getIndexerBin();
  if (existsSync(indexerBin) && projects.length > 0) {
    console.log('  Syncing builtin types...');
    const syncResult = spawnSync('node', [indexerBin, 'sync-types'], {
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    if (syncResult.status === 0) {
      console.log(`  ${GREEN}Types synced.${RESET}`);
    } else {
      const msg = (syncResult.stderr ?? syncResult.stdout ?? '').trim();
      console.warn(`  ${YELLOW}Warning: sync-types failed: ${msg || 'unknown error'}${RESET}`);
    }
  }

  // ── Daemon setup ──────────────────────────────────────────────────────────

  const firstProject = projects[0];

  if (isDaemonSupported() && firstProject) {
    console.log(`\n${BOLD}Step 4: Daemon Setup${RESET}`);
    const wantDaemon = await confirm('Set up auto-indexing daemon?', false);
    if (wantDaemon) {
      try {
        await installDaemon(indexerBin, firstProject.name);
        console.log(`  ${GREEN}Daemon installed.${RESET}`);
      } catch (err) {
        console.warn(`  ${YELLOW}Daemon setup failed: ${(err as Error).message}${RESET}`);
      }
    } else {
      console.log(`  ${DIM}Skipped.${RESET}`);
    }
  }

  // ── MCP registration ──────────────────────────────────────────────────────

  console.log(`\n${BOLD}Step 5: MCP Registration${RESET}`);

  const mcpServerBin = getMcpServerBin();

  const wantMcp = await confirm('Register MCP server with Claude Desktop?', false);
  if (wantMcp) {
    try {
      registerMcpClaudeDesktop(mcpServerBin);
    } catch (err) {
      console.warn(`  ${YELLOW}MCP registration failed: ${(err as Error).message}${RESET}`);
    }
  } else {
    console.log(`  ${DIM}Skipped.${RESET}`);
  }

  const wantClaudeMd = await confirm('Add CoffeeCtx instructions to CLAUDE.md?', false);
  if (wantClaudeMd && firstProject?.repoPath) {
    try {
      appendClaudeMd(firstProject.repoPath, mcpServerBin);
    } catch (err) {
      console.warn(`  ${YELLOW}CLAUDE.md update failed: ${(err as Error).message}${RESET}`);
    }
  } else if (wantClaudeMd && !firstProject?.repoPath) {
    console.log(`  ${DIM}No repo path configured — skipping CLAUDE.md.${RESET}`);
  } else {
    console.log(`  ${DIM}Skipped.${RESET}`);
  }

  // Always print the MCP config for manual use
  console.log(`\n  ${DIM}MCP server config (for manual use):${RESET}`);
  console.log(
    '  ' +
      JSON.stringify({ command: 'node', args: [mcpServerBin] }, null, 2).replace(/\n/g, '\n  '),
  );

  // ── Summary ───────────────────────────────────────────────────────────────

  console.log(`\n${BOLD}${GREEN}Setup complete!${RESET}`);
  console.log('');
  console.log('  Next steps:');
  console.log('');
  console.log(`  ${CYAN}Index your project:${RESET}`);
  console.log('    coffeectx-index index');
  console.log('');
  console.log(`  ${CYAN}Start the auto-indexing daemon:${RESET}`);
  console.log('    coffeectx-index daemon');
  console.log('');
  console.log(`  ${CYAN}Add the MCP server to your AI assistant:${RESET}`);
  console.log(`    command: node`);
  console.log(`    args: ["${mcpServerBin}"]`);
  console.log('');
}

// ── Entry point ───────────────────────────────────────────────────────────────

main()
  .catch(err => {
    console.error(`\nSetup error: ${(err as Error).message}`);
  })
  .finally(() => {
    close();
    process.exit(0);
  });
