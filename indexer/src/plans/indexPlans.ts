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
import { parseQuery, executeQuery } from '@coffeectx/core';
import type { Db, InsertEntry } from '@coffeectx/core';
import { extractIdentifiers } from '../agentLog/enricher.js';
import type { SnapshotSupervisor } from '../lsp/snapshotSupervisor.js';

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

/** Markdown link target — captures the URL/path inside `[label](target)`. */
const MD_LINK_RE = /\[[^\]]*\]\(([^)\s]+)/g;
/** Backtick-fenced inline code — captures whatever's between single backticks. */
const INLINE_CODE_RE = /`([^`\n]{2,})`/g;

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

/** Pull the first-line H1 or the first non-empty trimmed line, capped at 200 chars. */
function extractTitle(content: string): string | null {
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    const m = t.match(/^#+\s+(.+)$/);
    const candidate = m ? m[1]!.trim() : t;
    if (!candidate) continue;
    return candidate.length > 200 ? candidate.slice(0, 197) + '…' : candidate;
  }
  return null;
}

/**
 * Parse a plan's markdown body and resolve any references the graph can
 * represent at write time:
 *  - File paths land as plain Symbol strings in `Plan.relatedFiles`.
 *  - Identifier candidates (inline-code tokens) resolve to LSP symbol ids
 *    — single non-excluded ancestor or drop.
 */
async function resolvePlanLinks(content: string, db: Db): Promise<{
  filePaths: string[];
  symbolRefs: { $id: string }[];
}> {
  const filePaths = extractFilePathCandidates(content);
  const identifiers = extractIdentifierCandidates(content);

  const symbolOwners = new Set<string>();
  for (const ident of identifiers) {
    const owner = await resolveSingleNamedOwnerIn(ident, db, LSP_SYMBOL_TYPES);
    if (owner) symbolOwners.add(owner);
  }

  return {
    filePaths,
    symbolRefs: [...symbolOwners].map($id => ({ $id })),
  };
}

/** `Plan.relatedSymbols` accepts these types only (matches AnyLspSymbol). A
 *  loose blacklist (e.g. exclude Plan) lets unrelated owners like AgentSession
 *  / Span through and the insert then rejects the whole batch. Whitelisting
 *  here matches the field's schema exactly. */
const LSP_SYMBOL_TYPES = new Set([
  'LspModule', 'LspNamespace', 'LspClass', 'LspInterface',
  'LspEnum', 'LspFunction', 'LspMethod', 'LspConstructor',
]);

/** Pull every `[label](target)` target whose path looks like a file. */
export function extractFilePathCandidates(content: string): string[] {
  const out = new Set<string>();
  for (const m of content.matchAll(MD_LINK_RE)) {
    const target = m[1]!.trim();
    if (!target) continue;
    if (/^https?:/i.test(target)) continue;
    if (/^mailto:/i.test(target)) continue;
    if (target.startsWith('#')) continue;
    const stripped = target.split(/[#:]/, 1)[0]!.trim();
    if (stripped) out.add(stripped);
  }
  return [...out];
}

/** Pull identifier-shaped tokens from inline code spans. */
export function extractIdentifierCandidates(content: string): string[] {
  const codeSpans: string[] = [];
  for (const m of content.matchAll(INLINE_CODE_RE)) {
    codeSpans.push(m[1]!);
  }
  const all = new Set<string>();
  for (const span of codeSpans) {
    for (const id of extractIdentifiers(span)) all.add(id);
  }
  return [...all];
}

/** Resolve `value` to its single named-type ancestor whose type is in `allowed`. */
async function resolveSingleNamedOwnerIn(
  value: string, db: Db, allowed: Set<string>,
): Promise<string | null> {
  const symbolIds = await querySymbolExact(value, db);
  if (symbolIds.length === 0) return null;
  const owners = new Set<string>();
  for (const sid of symbolIds) {
    const p = db.findNamedParent(sid);
    if (!p) continue;
    if (!allowed.has(p.typeName)) continue;
    owners.add(p.id);
    if (owners.size > 1) return null;
  }
  return owners.size === 1 ? [...owners][0]! : null;
}

async function querySymbolExact(value: string, db: Db): Promise<string[]> {
  try {
    const q = parseQuery(`Symbol "${escapeStr(value)}"`);
    return await executeQuery(q, db);
  } catch {
    return [];
  }
}

function escapeStr(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
