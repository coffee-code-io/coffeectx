/**
 * Plans indexer — supervisor-driven.
 *
 * Claude writes plan-mode markdown to `~/.claude/plans/<slug>.md`. The
 * SnapshotSupervisor captures every byte-for-byte revision as a snapshot
 * under `~/.coffeecode/snapshots/<project>/<sha>/<ts>.md`. This job drains
 * those snapshots and mints one Plan node per file per drain, taking the
 * latest snapshot per relPath in the batch.
 *
 * Unlike the LSP indexer, plans are NOT versioned: a re-write of the same
 * slug in a new planning session yields a brand-new Plan node (separate
 * timeline, fresh uuid, no `bumpVersion`). The downstream span linker
 * attaches each plan to whatever Span(s) wrote it.
 *
 * Reverse-pass link backfilling (the old job's per-run "retry resolving
 * unmatched references") is dropped — Plan nodes are now point-in-time
 * immutable captures; relatedFiles/relatedSymbols reflect what was
 * resolvable at write time.
 */

import { readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import type { Db, InsertEntry } from '@coffeectx/core';
import type { SnapshotSupervisor } from '../lsp/snapshotSupervisor.js';
import { extractTitle, resolvePlanLinks } from './planExtract.js';

export interface IndexPlansOptions {
  /** Absolute path of the plans directory (the supervisor's watch root). */
  plansDir: string;
  supervisor: SnapshotSupervisor;
  /** Highest snapshot ts the previous run consumed. The supervisor returns
   *  rows strictly newer than this. */
  lastConsumedTs: number;
}

export interface IndexPlansResult {
  /** Distinct plan files seen in this drain (the bucket count after grouping
   *  by relPath). */
  files: number;
  /** Plan nodes successfully minted this run. */
  inserted: number;
  errors: Array<{ path: string; error: string }>;
  /** Max snapshot ts consumed — caller persists via setJobState. */
  consumedTs: number;
}

export async function indexPlans(db: Db, options: IndexPlansOptions): Promise<IndexPlansResult> {
  const result: IndexPlansResult = {
    files: 0, inserted: 0, errors: [], consumedTs: options.lastConsumedTs,
  };

  const drained = options.supervisor.drainSince(options.plansDir, options.lastConsumedTs);
  if (drained.size === 0) return result;

  for (const [relPath, snapshots] of drained) {
    if (snapshots.length === 0) continue;
    if (extname(relPath).toLowerCase() !== '.md') continue;
    result.files++;

    // drainSince returns snapshots ascending by ts; the last entry is the
    // most recent revision we should commit as the Plan body. Older
    // snapshots in the same batch are subsumed (they're transitional saves
    // within one drain interval) and discarded by gcKeepingLatest below.
    const latest = snapshots[snapshots.length - 1]!;
    if (latest.ts > result.consumedTs) result.consumedTs = latest.ts;

    let content: string;
    try {
      content = readFileSync(latest.snapshotPath, 'utf-8');
    } catch (err) {
      result.errors.push({ path: latest.snapshotPath, error: (err as Error).message });
      continue;
    }

    const name = basename(relPath, extname(relPath));
    const absPath = join(options.plansDir, relPath);
    const title = extractTitle(content);
    const { filePaths, symbolRefs } = await resolvePlanLinks(content, db);

    const entry: InsertEntry = {
      type: 'Plan',
      data: {
        name,
        path: absPath,
        content,
        ...(title ? { title } : {}),
        relatedFiles: filePaths,
        relatedSymbols: symbolRefs,
      },
      // File mtime is when Claude's Write tool actually touched the disk —
      // a tighter proxy for "when this content existed" than the supervisor
      // ts (which is Date.now() at scan moment and can lag the write by
      // minutes in batched/replay runs). Fall back to ts if mtime is 0/missing.
      createdAt: latest.mtimeMs || latest.ts,
      updatedAt: latest.mtimeMs || latest.ts,
    };
    try {
      const r = await db.insertEntries([entry]);
      if (r.errors.length > 0) {
        result.errors.push({ path: absPath, error: r.errors.map(e => e.message).join('; ') });
      } else {
        result.inserted++;
      }
    } catch (err) {
      result.errors.push({ path: absPath, error: (err as Error).message });
    }
  }

  // Done with this drain — keep only the newest snapshot per relPath on disk.
  options.supervisor.gcKeepingLatest(options.plansDir);

  return result;
}

// Title / link / identifier extraction helpers live in `./planExtract.ts` —
// shared with the codex provider's in-message `<proposed_plan>` extractor.
