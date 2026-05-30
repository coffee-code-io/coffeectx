/**
 * Run the indexing pipeline once against the live (post-restore) state.
 *
 *   1. open project DB, sync types
 *   2. ClaudeProvider → indexAgentSessions
 *   3. (unless skipLsp) indexWithLsp against the existing snapshot index.jsonl
 *   4. linkSpans
 *
 * Steps are wrapped in try/finally so partial failure still closes the DB
 * + LSP client. The supervisor instance in step 3 is created without
 * `start()` — `drainSince` and `gcKeepingLatest` read the JSONL directly
 * and don't depend on live chokidar watchers.
 */

import { homedir } from 'node:os';
import {
  Db, createEmbedFn, loadConfig, resolveProjectEmbed, syncAllTypes,
} from '@coffeectx/core';
import { indexAgentSessions } from '@coffeectx/indexer/dist/agentLog/indexLogs.js';
import { ClaudeProvider } from '@coffeectx/indexer/dist/agentLog/providers/claude.js';
import { linkSpans } from '@coffeectx/indexer/dist/agentLog/spanLink.js';
import { indexWithLsp } from '@coffeectx/indexer/dist/lsp/indexSymbols.js';
import { SnapshotSupervisor } from '@coffeectx/indexer/dist/lsp/snapshotSupervisor.js';
import { loadFileHashes } from '@coffeectx/indexer/dist/fileHashes.js';
import { claudeLogsDirFor, projectDbPath } from './paths.js';

const DEFAULT_LSP_COMMAND = 'typescript-language-server --stdio';

export interface RunOptions {
  project: string;
  /** Skip the LSP step. Useful when only tuning agent-log heuristics. */
  skipLsp?: boolean;
  /** Wall-clock override for the hard-break gate. Defaults to `Date.now()`. */
  closeBeforeMs?: number;
}

export interface RunResult {
  logs: { sessions: number; events: number; spans: number; inserted: number; errors: number };
  lsp: { files: number; nodes: number; bumped: number; deleted: number; skipped: boolean; errors: number } | null;
  link: { scanned: number; linked: number; symbols: number; errors: number };
}

export async function runFullChain(opts: RunOptions): Promise<RunResult> {
  const config = loadConfig();
  const projectEntry = config.projects[opts.project];
  if (!projectEntry) throw new Error(`unknown project: ${opts.project}`);

  const repoPath = projectEntry.repoPath;
  if (!repoPath) throw new Error(`project ${opts.project} has no repoPath set in config`);

  const claudeLogsPath = readClaudeLogsPath(projectEntry) ?? claudeLogsDirFor(repoPath);
  const embedCfg = resolveProjectEmbed(config, opts.project);
  const embedFn = createEmbedFn(embedCfg);
  const db = new Db({ path: projectDbPath(opts.project), embed: embedFn, dimensions: embedCfg.dimensions });

  const result: RunResult = {
    logs: { sessions: 0, events: 0, spans: 0, inserted: 0, errors: 0 },
    lsp: null,
    link: { scanned: 0, linked: 0, symbols: 0, errors: 0 },
  };

  try {
    syncAllTypes(db);

    // 1. Agent log
    const provider = new ClaudeProvider({ paths: [claudeLogsPath] });
    const hashes = loadFileHashes();
    const r = await indexAgentSessions(db, provider, {
      hashes,
      repoPath,
      closeBeforeMs: opts.closeBeforeMs,
    });
    result.logs = {
      sessions: r.sessions,
      events: r.events,
      spans: r.spans,
      inserted: r.inserted,
      errors: r.errors.length,
    };

    // 2. LSP
    if (!opts.skipLsp) {
      const lspCmd = readLspCommand(projectEntry) ?? DEFAULT_LSP_COMMAND;
      const [bin, ...args] = lspCmd.trim().split(/\s+/).filter(Boolean);
      if (!bin) throw new Error(`invalid lspCommand: "${lspCmd}"`);
      const binPath = bin.startsWith('~/') ? `${homedir()}/${bin.slice(2)}` : bin;
      const supervisor = new SnapshotSupervisor({ projectName: opts.project, repoPaths: [repoPath] });
      const lspRes = await indexWithLsp(db, repoPath, binPath, args, {
        supervisor,
        lastConsumedTs: 0,
        cutoffMs: db.getMaxClosedSpanEndedAt() ?? undefined,
      });
      result.lsp = {
        files: lspRes.files,
        nodes: lspRes.nodes,
        bumped: lspRes.bumped,
        deleted: lspRes.deleted,
        skipped: lspRes.skipped,
        errors: lspRes.errors.length,
      };
    }

    // 3. Span ↔ LSP linker
    const linkRes = await linkSpans(db);
    result.link = {
      scanned: linkRes.scanned,
      linked: linkRes.linked,
      symbols: linkRes.symbols,
      errors: linkRes.errors.length,
    };
  } finally {
    try { db.close(); } catch { /* idempotent */ }
  }

  return result;
}

function readClaudeLogsPath(projectEntry: { jobs?: Record<string, { parameters?: Record<string, unknown> }> }): string | undefined {
  const path = projectEntry.jobs?.claude?.parameters?.['path'];
  return typeof path === 'string' && path.length > 0 ? path : undefined;
}

function readLspCommand(projectEntry: { jobs?: Record<string, { parameters?: Record<string, unknown> }> }): string | undefined {
  const cmd = projectEntry.jobs?.lsp?.parameters?.['lspCommand'];
  return typeof cmd === 'string' && cmd.length > 0 ? cmd : undefined;
}
