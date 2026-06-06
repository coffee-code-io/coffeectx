#!/usr/bin/env node
/**
 * coffeectx-replay — record / backup / restore / run / replay for
 * iterative tuning of agent-log span heuristics + the LSP pipeline.
 *
 * See ../README or `coffeectx-replay --help` for the surface.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '@coffeectx/core';
import { backup } from './backup.js';
import { record } from './record.js';
import { resetDb, resetHashes, resetSnapshots } from './reset.js';
import { restore } from './restore.js';
import { runFullChain } from './run.js';
import { readManifest } from './manifest.js';
import { BACKUPS_DIR, backupDir } from './paths.js';

const HELP = `coffeectx-replay <command> [options]

Commands:
  record   [--project <name>]                  Run a standalone snapshot supervisor.
  backup   [--name <name>] [--project <name>]  Snapshot project state into ~/.coffeecode/backups/<name>/.
  restore  <name>          [--project <name>]  Wipe live state and restore from backup.
  reset                    [--project <name>]  Just wipe DB + project-scoped hashes (keeps snapshots + logs).
  run                      [--project <name>] [--skip-lsp] [--close-before-ms <ms>]
                                               Execute the full pipeline once.
  replay   <name>          [--project <name>] [--skip-lsp] [--close-before-ms <ms>]
                                               Shorthand for restore + run. <name> also accepted as --name <name>.
                                               --close-before-ms defaults to Number.MAX_SAFE_INTEGER so every span finalises.
  list                                         List backups under ~/.coffeecode/backups/.
  help                                         Show this message.

Project resolution: --project, or "active" from config.yaml.
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0) { console.log(HELP); return; }

  const cmd = argv[0]!;
  const rest = argv.slice(1);
  const flags = parseFlags(rest);
  const project = (flags['--project'] as string | undefined) ?? activeProject();

  switch (cmd) {
    case 'help': case '--help': case '-h':
      console.log(HELP);
      return;

    case 'record': {
      requireProject(project);
      await record({ project: project! });
      return;
    }

    case 'backup': {
      requireProject(project);
      const r = backup({ project: project!, name: flags['--name'] as string | undefined });
      console.log(`[backup] wrote ${r.dir}`);
      console.log(`         project=${r.manifest.project}  recordedAt=${r.manifest.recordedAt}`);
      console.log(`         snapshots=${r.manifest.sources.snapshots.count} (${humanBytes(r.manifest.sources.snapshots.totalBytes)})`);
      console.log(`         db=${humanBytes(r.manifest.sources.db.bytes)}  hashes=${r.manifest.sources.fileHashes.entryCount}  logs=${r.manifest.sources.claudeLogs.sessions} sessions`);
      return;
    }

    case 'restore': {
      requireProject(project);
      const name = positional(rest);
      if (!name) throw new Error('restore: missing <name>');
      const m = restore({ project: project!, name });
      console.log(`[restore] restored project=${m.project} from backup=${name}`);
      return;
    }

    case 'reset': {
      requireProject(project);
      resetDb(project!);
      resetHashes(project!);
      console.log(`[reset] wiped DB + project-scoped hashes for ${project}`);
      return;
    }

    case 'reset-snapshots': {
      requireProject(project);
      resetSnapshots(project!);
      console.log(`[reset-snapshots] purged snapshots for ${project}`);
      return;
    }

    case 'run': {
      requireProject(project);
      const r = await runFullChain({
        project: project!,
        skipLsp: !!flags['--skip-lsp'],
        closeBeforeMs: numericFlag(flags, '--close-before-ms'),
      });
      printRun(r);
      return;
    }

    case 'replay': {
      requireProject(project);
      const name = (flags['--name'] as string | undefined) ?? positional(rest);
      if (!name) throw new Error('replay: missing <name>');
      const m = restore({ project: project!, name });
      console.log(`[replay] restored project=${m.project} from backup=${name}`);
      // Replays operate on historical logs by definition — `Date.now()`
      // is irrelevant, and using it as the HARD_BREAK anchor breaks any
      // log whose final event lands within 5 minutes of wall-clock. Pin
      // the gate far in the future so every span finalises. The caller
      // can still override with `--close-before-ms`.
      const closeBeforeMs = numericFlag(flags, '--close-before-ms') ?? Number.MAX_SAFE_INTEGER;
      const r = await runFullChain({
        project: project!,
        skipLsp: !!flags['--skip-lsp'],
        closeBeforeMs,
      });
      printRun(r);
      return;
    }

    case 'list': {
      if (!existsSync(BACKUPS_DIR)) { console.log('(no backups)'); return; }
      const names = readdirSync(BACKUPS_DIR).sort();
      if (names.length === 0) { console.log('(no backups)'); return; }
      for (const name of names) {
        const manifestPath = join(backupDir(name), 'manifest.json');
        if (!existsSync(manifestPath)) continue;
        try {
          const m = readManifest(manifestPath);
          console.log(
            name.padEnd(40),
            'project=' + m.project.padEnd(16),
            'at=' + m.recordedAt,
            'snapshots=' + m.sources.snapshots.count,
            'sessions=' + m.sources.claudeLogs.sessions,
          );
        } catch { /* skip malformed */ }
      }
      return;
    }

    default:
      console.error(`unknown command: ${cmd}\n`);
      console.log(HELP);
      process.exit(1);
  }
}

function parseFlags(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { out[a] = true; }
    else { out[a] = next; i++; }
  }
  return out;
}

function positional(argv: string[]): string | undefined {
  return argv.find(a => !a.startsWith('--'));
}

function numericFlag(flags: Record<string, string | boolean>, key: string): number | undefined {
  const v = flags[key];
  if (typeof v !== 'string') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function activeProject(): string | undefined {
  try { return loadConfig().active; } catch { return undefined; }
}

function requireProject(p: string | undefined): asserts p is string {
  if (!p) throw new Error('no project — pass --project <name> or set `active` in config.yaml');
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`;
}

function printRun(r: { logs: Record<string, number>; lsp: Record<string, number | boolean> | null; plans: Record<string, number>; link: Record<string, number> }): void {
  console.log('[run] logs: ', r.logs);
  console.log('[run] lsp:  ', r.lsp ?? '(skipped)');
  console.log('[run] plans:', r.plans);
  console.log('[run] link: ', r.link);
}

// Silently report and exit on stat errors so we don't leak stack traces.
void statSync; // tsc unused-vars guard if I drop the helper later

main().catch(err => {
  console.error('[coffeectx-replay] error:', (err as Error).message);
  process.exit(1);
});
