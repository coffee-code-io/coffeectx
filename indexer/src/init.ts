import { mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Db, syncAllTypes, loadConfig, updateConfig } from '@coffeectx/core';
import type { SyncResult, AuthSettings } from '@coffeectx/core';
import { DB_DIR, dbPathForName, registerProject, setProjectLogsPath, sanitizeName } from './projects.js';
import { ask, choose, confirm, CancelError } from './setup/prompt.js';

export interface InitResult {
  name: string;
  dbPath: string;
  repoPath?: string;
  /** Convenience echo: the value written to `jobs.logs.parameters.logsPath`. */
  logsPath?: string;
  alreadyExisted: boolean;
  sync: SyncResult;
}

/**
 * Initialize a new project database.
 *
 * - Creates ~/.coffeecode/db/<name>.db
 * - Runs schema DDL and syncs all built-in types
 * - Registers the project in ~/.coffeecode/projects.yaml
 * - Sets it as active if no other project is active yet
 */
export function initProject(name: string, repoPath?: string, logsPath?: string): InitResult {
  const safe = sanitizeName(name);
  if (!safe) throw new Error(`"${name}" is not a valid project name`);

  mkdirSync(DB_DIR, { recursive: true });

  const dbPath = dbPathForName(safe);
  const alreadyExisted = existsSync(dbPath);

  // Db constructor creates tables on first open
  const cfg = loadConfig();
  const db = new Db({ path: dbPath, embed: async () => new Float32Array(128) });
  const sync = syncAllTypes(db, {
    builtinFilter: { include: cfg.types.include, exclude: cfg.types.exclude },
    userDir: cfg.types.userDir,
  });
  db.close();

  registerProject(safe, dbPath, repoPath);
  if (logsPath) setProjectLogsPath(safe, logsPath);

  return { name: safe, dbPath, repoPath, logsPath, alreadyExisted, sync };
}

/** Prompt for a project name interactively (TTY only). */
export async function promptProjectName(): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error('stdin is not a TTY — pass --name <name> explicitly');
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question('Project name: ', answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ── Interactive init (TTY only) ──────────────────────────────────────────────
//
// `retrival-index init` extends the bare `initProject(...)` with two optional
// prompt blocks:
//   1. Coding-agent auth (provider / model / apiKey) — seeds the `claude` and
//      `local-decisions` jobs with `parameters.auth = {...}`. Skip → those
//      jobs land disabled-and-unconfigured (the user can fill them in via the
//      Scheduler tab's Configure & enable later).
//   2. LSP command — seeds the `lsp` job with `parameters.lspCommand` and the
//      project's `repoPath` (if known). Skip → lsp stays unconfigured.
//
// Each block is wrapped in its own confirm() so users can opt out without
// abandoning the whole flow. CancelError (ESC) from `prompt.ts` is treated as
// "skip this block".

const PROVIDER_OPTIONS = ['anthropic', 'openai', 'openrouter', 'google', 'xai'] as const;
type ProviderId = typeof PROVIDER_OPTIONS[number];

const PROVIDER_DEFAULT_MODEL: Record<ProviderId, string> = {
  anthropic:  'claude-sonnet-4-6',
  openai:     'gpt-4o-mini',
  openrouter: 'anthropic/claude-sonnet-4-5',
  google:     'gemini-2.0-flash',
  xai:        'grok-2-latest',
};

const DEFAULT_LSP_COMMAND = 'typescript-language-server --stdio';
const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects');

/** `/Users/dima/foo` → `-Users-dima-foo` (Claude's slug convention). */
function repoPathToClaudeDir(repoPath: string): string {
  return join(CLAUDE_PROJECTS_DIR, repoPath.replace(/\//g, '-'));
}

/**
 * Run the interactive seed flow on top of an already-initialised project.
 * Safe to call repeatedly: every prompt block is optional, and we only patch
 * the fields the user provides — existing config is preserved.
 */
export async function interactiveSeedJobs(projectName: string, repoPath?: string): Promise<void> {
  if (!process.stdin.isTTY) return;

  // ── Coding-agent auth ──────────────────────────────────────────────────────
  console.log('\nCoding-agent auth (used by local-decisions and the UI agent).');
  let auth: AuthSettings | null = null;
  try {
    if (await confirm('  Configure a coding agent now?', true)) {
      const providerLabel = await choose(
        '  Provider',
        PROVIDER_OPTIONS.map(p => p),
        0,
      );
      const provider = providerLabel as ProviderId;
      const model = await ask('  Model', PROVIDER_DEFAULT_MODEL[provider]);
      let apiKey = '';
      while (!apiKey) {
        apiKey = await ask('  API key (visible in config.yaml)');
        if (!apiKey) console.log('  API key cannot be empty (or ESC to skip auth).');
      }
      auth = { authType: provider, model, apiKey };
    }
  } catch (err) {
    if (!(err instanceof CancelError)) throw err;
    console.log('  (skipped)');
  }

  // ── LSP server ─────────────────────────────────────────────────────────────
  console.log('\nLSP server (powers the `lsp` job — source indexing).');
  let lspCommand: string | null = null;
  try {
    if (await confirm('  Configure an LSP server now?', !!repoPath)) {
      lspCommand = (await ask('  LSP command', DEFAULT_LSP_COMMAND)).trim();
      if (!lspCommand) lspCommand = null;
    }
  } catch (err) {
    if (!(err instanceof CancelError)) throw err;
    console.log('  (skipped)');
  }

  if (!auth && !lspCommand) return; // nothing to write

  updateConfig(cfg => {
    const entry = cfg.projects[projectName];
    if (!entry) throw new Error(`Project "${projectName}" not found in config`);
    if (!entry.jobs) entry.jobs = {};
    const jobs = entry.jobs;

    if (auth) {
      // claude (Claude Code logs): enabled, with derived `path` if we have
      // a repo. local-decisions: enabled, with the shared auth block.
      const claudePath = repoPath ? repoPathToClaudeDir(repoPath) : undefined;
      jobs['claude'] = {
        ...(jobs['claude'] ?? {}),
        enabled: true,
        parameters: {
          ...(jobs['claude']?.parameters ?? {}),
          ...(claudePath ? { path: claudePath } : {}),
        },
      };
      jobs['local-decisions'] = {
        ...(jobs['local-decisions'] ?? {}),
        enabled: true,
        parameters: {
          ...(jobs['local-decisions']?.parameters ?? {}),
          auth,
        },
      };
    }

    if (lspCommand) {
      jobs['lsp'] = {
        ...(jobs['lsp'] ?? {}),
        enabled: true,
        parameters: {
          ...(jobs['lsp']?.parameters ?? {}),
          lspCommand,
          ...(repoPath ? { repoPath } : {}),
        },
      };
    }
  });

  console.log('\nSeeded job config:');
  if (auth) console.log('  - claude (enabled) + local-decisions (enabled)');
  if (lspCommand) console.log('  - lsp (enabled)');
}
