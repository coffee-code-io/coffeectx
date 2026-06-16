/**
 * `coffeectx init <name>` — single-positional-arg enrolment.
 *
 * Two paths:
 *   - Project name UNKNOWN: TTY-only. Six prompts (repoPath, lspCommand,
 *     agent-logs source, embed auth, indexer auth, UI auth), then write
 *     config + create DB + sync types + take the first snapshot of the repo
 *     so the LSP job (a strict snapshot consumer post-refactor) has
 *     something to read before the daemon comes up.
 *   - Project name KNOWN: skip prompts. Just ensure the DB exists with the
 *     current type set and run the first-snapshot pass. Idempotent — safe
 *     to invoke as a "bootstrap me" command on an existing config.
 */

import { mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  Db, syncAllTypes, loadConfig, updateConfig, validateAuth, CLAUDE_DIR,
  defaultPiSessionsDirFor,
} from '@coffeectx/core';
import type { AuthSettings, JobConfig, ProjectEntry, SyncResult } from '@coffeectx/core';
import { DB_DIR, dbPathForName, sanitizeName } from './projects.js';
import { ask, choose, CancelError, close as closePrompt } from './prompt.js';
import { runFirstSnapshot } from './lsp/snapshotSupervisor.js';

const DEFAULT_LSP_COMMAND = 'typescript-language-server --stdio';
const CLAUDE_PROJECTS_DIR = join(CLAUDE_DIR, 'projects');
const DEFAULT_CODEX_STATE_PATH = join(homedir(), '.codex', 'state_5.sqlite');
const DEFAULT_PLANS_DIR = join(CLAUDE_DIR, 'plans');

const AGENT_LOG_KINDS = ['claude', 'codex', 'pi', 'none'] as const;
type AgentLogKind = typeof AGENT_LOG_KINDS[number];

const EMBED_PROVIDERS = ['openai', 'openrouter'] as const;
const AGENT_AUTH_MODES = ['openai', 'anthropic', 'openrouter', 'openai-oauth'] as const;
type AgentAuthMode = typeof AGENT_AUTH_MODES[number];

const PROVIDER_DEFAULT_MODEL: Record<'openai' | 'anthropic' | 'openrouter', string> = {
  anthropic:  'claude-sonnet-4-6',
  openai:     'gpt-4o-mini',
  openrouter: 'anthropic/claude-sonnet-4-5',
};

const DEFAULT_EMBED_MODEL_BY_PROVIDER: Record<'openai' | 'openrouter', string> = {
  openai:     'text-embedding-3-small',
  openrouter: 'text-embedding-3-small',
};

export interface InitParams {
  repoPath: string;
  lspCommand: string;
  agentLogs: { kind: Exclude<AgentLogKind, 'none'>; path: string } | null;
  embedAuth: AuthSettings;     // always apiKey-mode
  indexerAuth: AuthSettings;
  uiAuth: AuthSettings;
}

export interface InitResult {
  name: string;
  dbPath: string;
  repoPath?: string;
  alreadyExisted: boolean;
  sync: SyncResult;
  snapshotted: boolean;
}

/** Top-level entry point invoked from the CLI dispatcher. */
export async function runInit(name: string): Promise<InitResult> {
  const safe = sanitizeName(name);
  if (!safe) throw new Error(`"${name}" is not a valid project name`);

  const cfg = loadConfig();
  const existing = cfg.projects[safe];

  if (existing) {
    // Idempotent re-init: types + DB + first-snapshot only. No prompts,
    // no config writes — anything else risks clobbering a hand-edited
    // config.yaml.
    console.log(`Re-initialising existing project "${safe}".`);
    const res = await bootstrapDbAndSnapshot(safe, existing.db, existing.repoPath);
    return { name: safe, alreadyExisted: true, ...res };
  }

  if (!process.stdin.isTTY) {
    throw new Error(
      `project "${safe}" not in config. New-project init needs a TTY for the setup prompts.`,
    );
  }

  let params: InitParams;
  try {
    params = await promptInitParams();
  } catch (err) {
    if (err instanceof CancelError) {
      throw new Error('init cancelled — no config or DB changes written.');
    }
    throw err;
  } finally {
    closePrompt();
  }

  const dbPath = dbPathForName(safe);
  writeInitConfig(safe, dbPath, params);
  const res = await bootstrapDbAndSnapshot(safe, dbPath, params.repoPath);
  return { name: safe, alreadyExisted: false, ...res };
}

// ── DB + first-snapshot bootstrap ────────────────────────────────────────────

async function bootstrapDbAndSnapshot(
  name: string,
  dbPath: string,
  repoPath?: string,
): Promise<Omit<InitResult, 'name' | 'alreadyExisted'>> {
  mkdirSync(DB_DIR, { recursive: true });

  const cfg = loadConfig();
  const db = new Db({ path: dbPath, embed: async () => new Float32Array(128) });
  const sync = syncAllTypes(db, {
    builtinFilter: { include: cfg.types.include, exclude: cfg.types.exclude },
    userDir: cfg.types.userDir,
  });
  db.close();
  console.log(`  DB:    ${dbPath}`);
  console.log(`  Types: synced ${sync.types.synced.length} types`);
  if (sync.types.errors.length > 0) {
    console.error('  Sync errors:');
    for (const { name: n, error } of sync.types.errors) {
      console.error(`    ${n}: ${error}`);
    }
  }

  let snapshotted = false;
  if (repoPath && existsSync(repoPath)) {
    console.log(`  Snapshot: bootstrapping from ${repoPath}…`);
    try {
      await runFirstSnapshot(name, repoPath);
      snapshotted = true;
      console.log(`  Snapshot: done.`);
    } catch (err) {
      console.error(`  Snapshot: failed — ${(err as Error).message}`);
    }
  } else if (repoPath) {
    console.warn(`  Snapshot: skipped — repoPath does not exist: ${repoPath}`);
  } else {
    console.warn(`  Snapshot: skipped — no repoPath configured for this project`);
  }

  return { dbPath, repoPath, sync, snapshotted };
}

// ── Prompts ──────────────────────────────────────────────────────────────────

async function promptInitParams(): Promise<InitParams> {
  console.log('\nNew project — answer six prompts to enrol it. ESC at any step cancels.\n');

  // 1. Repo path
  const repoAnswer = await ask('Repo path', process.cwd());
  const repoPath = resolve(repoAnswer);

  // 2. LSP command
  const lspAnswer = await ask('LSP command', DEFAULT_LSP_COMMAND);
  const lspCommand = lspAnswer.trim() || DEFAULT_LSP_COMMAND;

  // 3. Which agent logs to import
  const agentLogs = await promptAgentLogs(repoPath);

  // 4. Embed auth (apiKey only)
  console.log('\nEmbedding auth (apiKey only — OAuth/Codex tokens do not work for embeddings).');
  const embedAuth = await promptEmbedAuth();

  // 5. Indexer auth (apiKey or openai-oauth)
  console.log('\nIndexer auth (used by the per-Span indexer job).');
  const indexerAuth = await promptAgentAuth();

  // 6. UI agent auth (apiKey or openai-oauth)
  console.log('\nUI agent auth (used by the right-sidebar chat in the webui).');
  const uiAuth = await promptAgentAuth();

  return { repoPath, lspCommand, agentLogs, embedAuth, indexerAuth, uiAuth };
}

async function promptAgentLogs(
  repoPath: string,
): Promise<InitParams['agentLogs']> {
  const kind = await choose(
    'Import agent logs from',
    AGENT_LOG_KINDS.map(k => k),
    0,
  ) as AgentLogKind;
  if (kind === 'none') return null;
  const defaultPath = defaultAgentLogPath(kind, repoPath);
  const answered = await ask('  Path', defaultPath);
  return { kind, path: resolve(answered) };
}

function defaultAgentLogPath(kind: Exclude<AgentLogKind, 'none'>, repoPath: string): string {
  if (kind === 'claude') {
    return join(CLAUDE_PROJECTS_DIR, repoPath.replace(/\//g, '-'));
  }
  if (kind === 'codex') return DEFAULT_CODEX_STATE_PATH;
  // pi: derive from PI_AGENT_DIR (honors PI_CODING_AGENT_DIR override).
  return defaultPiSessionsDirFor(repoPath);
}

async function promptEmbedAuth(): Promise<AuthSettings> {
  const provider = await choose(
    '  Provider',
    EMBED_PROVIDERS.map(p => p),
    0,
  ) as 'openai' | 'openrouter';
  const model = await ask('  Model', DEFAULT_EMBED_MODEL_BY_PROVIDER[provider]);
  const apiKey = await askNonEmpty('  API key (visible in config.yaml)');
  const auth: AuthSettings = { authType: 'apiKey', provider, model, apiKey };
  validateAuth(auth, '<embed>');
  return auth;
}

async function promptAgentAuth(): Promise<AuthSettings> {
  const mode = await choose(
    '  Provider (or openai-oauth for the Codex login flow)',
    AGENT_AUTH_MODES.map(m => m),
    0,
  ) as AgentAuthMode;
  let auth: AuthSettings;
  if (mode === 'openai-oauth') {
    auth = { authType: 'openai-oauth' };
  } else {
    const model = await ask('  Model', PROVIDER_DEFAULT_MODEL[mode]);
    const apiKey = await askNonEmpty('  API key (visible in config.yaml)');
    auth = { authType: 'apiKey', provider: mode, model, apiKey };
  }
  validateAuth(auth, '<agent>');
  return auth;
}

async function askNonEmpty(label: string): Promise<string> {
  // Loop until non-empty. ESC still propagates (caller catches CancelError
  // and aborts init without writing anything).
  for (;;) {
    const v = await ask(label);
    if (v.length > 0) return v;
    console.log(`  ${label.trim()} cannot be empty (ESC to cancel init).`);
  }
}

// ── Config write ─────────────────────────────────────────────────────────────

function writeInitConfig(name: string, dbPath: string, params: InitParams): void {
  updateConfig(cfg => {
    if (!cfg.projects[name]) {
      const entry: ProjectEntry = {
        db: dbPath,
        enabled: true,
        repoPath: params.repoPath,
        created: new Date().toISOString(),
      };
      cfg.projects[name] = entry;
    } else {
      cfg.projects[name].db = dbPath;
      cfg.projects[name].repoPath = params.repoPath;
    }
    if (!cfg.active) cfg.active = name;

    const entry = cfg.projects[name];
    entry.core = { ...(entry.core ?? {}), embed: { ...(entry.core?.embed ?? {}), auth: params.embedAuth } };
    entry.agent = { ...(entry.agent ?? {}), auth: params.uiAuth };
    entry.jobs = { ...(entry.jobs ?? {}), ...buildJobsConfig(params) };
  });

  console.log(`\nWrote config for "${name}":`);
  console.log(`  Repo:        ${params.repoPath}`);
  console.log(`  LSP:         ${params.lspCommand}`);
  console.log(`  Agent logs:  ${params.agentLogs ? `${params.agentLogs.kind} @ ${params.agentLogs.path}` : 'none'}`);
  console.log(`  Embed auth:  ${describeAuth(params.embedAuth)}`);
  console.log(`  Indexer:     ${describeAuth(params.indexerAuth)}`);
  console.log(`  UI agent:    ${describeAuth(params.uiAuth)}`);
}

function buildJobsConfig(params: InitParams): Record<string, JobConfig> {
  const jobs: Record<string, JobConfig> = {};
  jobs['lsp'] = {
    enabled: true,
    parameters: { lspCommand: params.lspCommand, repoPath: params.repoPath },
  };
  jobs['plans']     = { enabled: true, parameters: { plansDir: DEFAULT_PLANS_DIR } };
  jobs['span-link'] = { enabled: true };
  jobs['indexer']   = { enabled: true, parameters: { auth: params.indexerAuth } };

  // Always declare all three agent-log jobs so `job list` shows the full
  // menu — only the selected one is enabled.
  const selected = params.agentLogs?.kind ?? null;
  jobs['claude'] = {
    enabled: selected === 'claude',
    parameters: selected === 'claude' ? { path: params.agentLogs!.path } : {},
  };
  jobs['codex'] = {
    enabled: selected === 'codex',
    parameters: selected === 'codex' ? { statePath: params.agentLogs!.path } : {},
  };
  jobs['pi'] = {
    enabled: selected === 'pi',
    parameters: selected === 'pi' ? { sessionsPath: params.agentLogs!.path } : {},
  };
  return jobs;
}

function describeAuth(auth: AuthSettings): string {
  if (auth.authType === 'openai-oauth') return 'openai-oauth (Codex)';
  if (auth.url) return `apiKey @ ${auth.url} (${auth.model ?? ''})`;
  return `apiKey @ ${auth.provider} (${auth.model ?? ''})`;
}
