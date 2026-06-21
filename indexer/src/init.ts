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
import { dirname, join, resolve } from 'node:path';
import {
  Db, syncAllTypes, loadConfig, updateConfig, validateAuth, CLAUDE_DIR,
  CODEX_STATE_PATH, defaultPiSessionsDirFor, COFFEECODE_DIR,
} from '@coffeectx/core';
import type { AuthSettings, JobConfig, ProjectEntry, SyncResult } from '@coffeectx/core';
import { dbPathForName, sanitizeName } from './projects.js';
import { ask, choose, CancelError, close as closePrompt } from './prompt.js';
import { resolveWatchSpecs, runFirstSnapshot } from './lsp/snapshotSupervisor.js';

const DEFAULT_LSP_COMMAND = 'typescript-language-server --stdio';
const CLAUDE_PROJECTS_DIR = join(CLAUDE_DIR, 'projects');
// Codex's session sqlite — derived from CODEX_HOME via core's resolver.
const DEFAULT_CODEX_STATE_PATH = CODEX_STATE_PATH;
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

/**
 * Default vector dimension for known embedding model families. Returns null
 * when the model isn't recognised — init then prompts the user. Numbers come
 * straight from each provider's docs and match what `createOpenAIEmbed`
 * passes through via the OpenAI `dimensions` request param.
 */
export function defaultEmbedDims(provider: string, model: string): number | null {
  const m = model.toLowerCase();
  // Accept bare `text-embedding-3-large` or namespaced `openai/text-embedding-3-large`.
  if (/(^|\/)text-embedding-3-large$/.test(m)) return 3072;
  if (/(^|\/)text-embedding-3-small$/.test(m)) return 1536;
  if (/(^|\/)text-embedding-ada-002$/.test(m)) return 1536;
  if (m.startsWith('nomic-embed-text')) return 768;
  void provider;
  return null;
}

export interface InitParams {
  repoPath: string;
  lspCommand: string;
  agentLogs: { kind: Exclude<AgentLogKind, 'none'>; path: string } | null;
  embedAuth: AuthSettings;     // always apiKey-mode
  embedDimensions: number;     // resolved at init time, persisted to config
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
  // Ensure every directory we're about to write to exists up front — fresh
  // installs (or `COFFEECODE_HOME` pointing at a brand-new sandbox dir)
  // may not have `~/.coffeecode/` yet, in which case `updateConfig` would
  // throw before we ever reach DB creation.
  ensureCoffeectxDirs(dbPath);
  writeInitConfig(safe, dbPath, params);
  const res = await bootstrapDbAndSnapshot(safe, dbPath, params.repoPath);
  return { name: safe, alreadyExisted: false, ...res };
}

/**
 * Recursively mkdir every directory init writes into:
 *   - `$COFFEECODE_DIR` itself (parent of `config.yaml`)
 *   - the actual `dbPath` parent — not the hardcoded `DB_DIR`, since
 *     re-inits may carry a custom path from an existing config entry.
 *
 * `mkdirSync({recursive: true})` is a no-op if the dir already exists, so
 * calling this from both `runInit` and `bootstrapDbAndSnapshot` is safe.
 */
function ensureCoffeectxDirs(dbPath: string): void {
  mkdirSync(COFFEECODE_DIR, { recursive: true });
  mkdirSync(dirname(dbPath), { recursive: true });
}

// ── DB + first-snapshot bootstrap ────────────────────────────────────────────

async function bootstrapDbAndSnapshot(
  name: string,
  dbPath: string,
  repoPath?: string,
): Promise<Omit<InitResult, 'name' | 'alreadyExisted'>> {
  // Cover the re-init path too: existing.db may live outside the default
  // DB_DIR (custom config entry), so mkdir the actual parent.
  ensureCoffeectxDirs(dbPath);

  const cfg = loadConfig();
  // syncAllTypes never embeds, so the stub fn / dims are inert — but pick
  // the same default as the rest of the stack so a future change that does
  // embed during type sync gets a consistent vec table.
  const dims = cfg.projects[name]?.core?.embed?.dimensions ?? 1536;
  const db = new Db({ path: dbPath, embed: async () => new Float32Array(dims), dimensions: dims });
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

  // Compute the same watch list the daemon would. Crucially this means we
  // do NOT snapshot `project.repoPath` directly — only the dirs that an
  // enabled `lsp[:*]` job actually consumes (or falls back to). On a
  // monorepo with narrow lsp:foo / lsp:bar subdir paths, that's the
  // difference between snapshotting two small dirs and trying to walk the
  // whole tree (chokidar then runs out of fs.watch slots).
  const watches = resolveWatchSpecs(
    cfg,
    name,
    cfg.projects[name]?.repoPath,
    Object.keys(cfg.projects[name]?.jobs ?? {}),
  );
  let snapshotted = false;
  if (watches.length === 0) {
    console.warn(`  Snapshot: skipped — no enabled lsp / plans-claude job to watch`);
  } else {
    const summary = watches.map(w => w.rootPath).join(', ');
    console.log(`  Snapshot: bootstrapping ${watches.length} root(s): ${summary}`);
    try {
      await runFirstSnapshot(name, watches);
      snapshotted = true;
      console.log(`  Snapshot: done.`);
    } catch (err) {
      console.error(`  Snapshot: failed — ${(err as Error).message}`);
    }
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

  // 4. Embed auth + dimensions (apiKey only)
  console.log('\nEmbedding auth (apiKey only — OAuth/Codex tokens do not work for embeddings).');
  const { auth: embedAuth, dimensions: embedDimensions } = await promptEmbedAuth();

  // 5. Indexer auth (apiKey or openai-oauth)
  console.log('\nIndexer auth (used by the per-Span indexer job).');
  const indexerAuth = await promptAgentAuth();

  // 6. UI agent auth (apiKey or openai-oauth)
  console.log('\nUI agent auth (used by the right-sidebar chat in the webui).');
  const uiAuth = await promptAgentAuth();

  return { repoPath, lspCommand, agentLogs, embedAuth, embedDimensions, indexerAuth, uiAuth };
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
  // pi: external pi installation, honors $PI_CODING_AGENT_DIR. Embedded pi
  // state always lives under coffeecode and isn't surfaced here.
  return defaultPiSessionsDirFor(repoPath);
}

async function promptEmbedAuth(): Promise<{ auth: AuthSettings; dimensions: number }> {
  const provider = await choose(
    '  Provider',
    EMBED_PROVIDERS.map(p => p),
    0,
  ) as 'openai' | 'openrouter';
  const model = await ask('  Model', DEFAULT_EMBED_MODEL_BY_PROVIDER[provider]);
  const apiKey = await askNonEmpty('  API key (visible in config.yaml)');
  const auth: AuthSettings = { authType: 'apiKey', provider, model, apiKey };
  validateAuth(auth, '<embed>');

  // Derive dimensions from the model when we recognise it; otherwise prompt.
  // The number is baked into the vec table on first DB open and cannot be
  // changed later without a full rebuild — get it right at init.
  const derived = defaultEmbedDims(provider, model);
  let dimensions: number;
  if (derived !== null) {
    dimensions = derived;
    console.log(`  Dimensions: ${dimensions} (derived from model)`);
  } else {
    for (;;) {
      const answer = await ask('  Dimensions', '1536');
      const n = Number(answer);
      if (Number.isInteger(n) && n > 0) { dimensions = n; break; }
      console.log('  Dimensions must be a positive integer.');
    }
  }
  return { auth, dimensions };
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
    entry.core = {
      ...(entry.core ?? {}),
      embed: {
        ...(entry.core?.embed ?? {}),
        auth: params.embedAuth,
        dimensions: params.embedDimensions,
      },
    };
    entry.agent = { ...(entry.agent ?? {}), auth: params.uiAuth };
    entry.jobs = { ...(entry.jobs ?? {}), ...buildJobsConfig(params) };
  });

  console.log(`\nWrote config for "${name}":`);
  console.log(`  Repo:        ${params.repoPath}`);
  console.log(`  LSP:         ${params.lspCommand}`);
  console.log(`  Agent logs:  ${params.agentLogs ? `${params.agentLogs.kind} @ ${params.agentLogs.path}` : 'none'}`);
  console.log(`  Embed auth:  ${describeAuth(params.embedAuth)} (${params.embedDimensions} dims)`);
  console.log(`  Indexer:     ${describeAuth(params.indexerAuth)}`);
  console.log(`  UI agent:    ${describeAuth(params.uiAuth)}`);
}

function buildJobsConfig(params: InitParams): Record<string, JobConfig> {
  const jobs: Record<string, JobConfig> = {};
  jobs['lsp'] = {
    enabled: true,
    parameters: { lspCommand: params.lspCommand, repoPath: params.repoPath },
  };
  jobs['span-link'] = { enabled: true };
  jobs['indexer']   = { enabled: true, parameters: { auth: params.indexerAuth } };

  // Always declare all three agent-log jobs so `job list` shows the full
  // menu — only the selected one is enabled.
  const selected = params.agentLogs?.kind ?? null;
  // plans-claude is a Claude-only disk-watcher (`~/.claude/plans/`). For
  // codex and pi projects, plans are extracted by the agent-log provider
  // itself, so the job stays off here.
  jobs['plans-claude'] = {
    enabled: selected === 'claude',
    parameters: { plansDir: DEFAULT_PLANS_DIR },
  };
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
