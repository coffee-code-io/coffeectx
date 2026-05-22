/**
 * Index Claude Code plan files into the knowledge graph as `Plan` nodes.
 *
 * Plans are markdown documents written during "plan mode" turns. Claude saves
 * them to `~/.claude/plans/<slug>.md`. They're high-signal artefacts because
 * they capture the agent's intended approach (context, files, verification)
 * before any code is written.
 *
 * One Plan node per `.md` file in the directory; the filename slug (sans
 * extension) is the dedup key.
 *
 * Linking is bidirectional and order-independent:
 *
 * - **Forward pass** on insert: parse `content` for markdown link targets
 *   (file paths) and fenced inline-code tokens (identifiers); resolve each
 *   against the current DB using exact-Symbol + findNamedParent. Only single,
 *   unambiguous matches are kept.
 * - **Reverse pass** every run: for every existing Plan node — even unchanged
 *   ones — re-resolve the same tokens and `appendListItemsUnique` any
 *   newly-resolvable refs into the existing `relatedFiles` / `relatedSymbols`
 *   lists. This means a Plan inserted before its referenced files/symbols
 *   existed gets linked the next time the indexer runs after those land.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { parseQuery, executeQuery } from '@coffeectx/core';
import type { Db, InsertEntry } from '@coffeectx/core';
import { extractIdentifiers } from '../agentLog/enricher.js';

export interface IndexPlansOptions {
  /** Absolute path of the plans directory. Defaults to `~/.claude/plans`. */
  plansDir: string;
}

export interface IndexPlansResult {
  scanned: number;
  inserted: number;
  patched: number;
  linksAdded: number;
  skipped: number;
  errors: Array<{ path: string; error: string }>;
}

/** Markdown link target — captures the URL/path inside `[label](target)`. */
const MD_LINK_RE = /\[[^\]]*\]\(([^)\s]+)/g;
/** Backtick-fenced inline code — captures whatever's between single backticks. */
const INLINE_CODE_RE = /`([^`\n]{2,})`/g;

/** Scan the directory and upsert Plan nodes. */
export async function indexPlans(db: Db, options: IndexPlansOptions): Promise<IndexPlansResult> {
  const result: IndexPlansResult = {
    scanned: 0, inserted: 0, patched: 0, linksAdded: 0, skipped: 0, errors: [],
  };

  let entries: string[];
  try {
    entries = readdirSync(options.plansDir);
  } catch (err) {
    result.errors.push({ path: options.plansDir, error: (err as Error).message });
    return result;
  }

  const existing = loadExistingPlans(db);

  for (const entry of entries) {
    if (extname(entry).toLowerCase() !== '.md') continue;
    const path = join(options.plansDir, entry);
    result.scanned++;

    let stat;
    try { stat = statSync(path); }
    catch (err) { result.errors.push({ path, error: (err as Error).message }); continue; }
    if (!stat.isFile()) continue;

    let content: string;
    try { content = readFileSync(path, 'utf-8'); }
    catch (err) { result.errors.push({ path, error: (err as Error).message }); continue; }

    const name = basename(entry, extname(entry));
    const updatedAt = new Date(stat.mtimeMs).toISOString();
    const createdAt = stat.birthtimeMs ? new Date(stat.birthtimeMs).toISOString() : updatedAt;
    const title = extractTitle(content);

    // Forward-pass link resolution (used for both new and existing plans).
    const { fileRefs, symbolRefs } = await resolvePlanLinks(content, db);

    const prior = existing.get(name);
    if (!prior) {
      const newEntry: InsertEntry = {
        type: 'Plan',
        data: {
          name,
          path,
          createdAt,
          updatedAt,
          content,
          ...(title ? { title } : {}),
          relatedFiles: fileRefs,
          relatedSymbols: symbolRefs,
        },
      };
      try {
        const r = await db.insertEntries([newEntry]);
        if (r.errors.length > 0) {
          result.errors.push({ path, error: r.errors.map(e => e.message).join('; ') });
        } else {
          result.inserted++;
        }
      } catch (err) {
        result.errors.push({ path, error: (err as Error).message });
      }
      continue;
    }

    // Existing plan — reverse-pass append any newly-resolvable refs.
    const added = appendLinksToExistingPlan(db, prior.id, fileRefs, symbolRefs);
    if (added > 0) {
      result.patched++;
      result.linksAdded += added;
    }

    if (prior.updatedAt !== updatedAt) {
      // mtime changed — Db patching only adds absent fields, so we can't easily
      // overwrite `content` / `updatedAt`. Surface this so the user can decide.
      console.warn(
        `[indexPlans] plan "${name}" changed on disk (mtime ${updatedAt}) but Db patching adds-only — ` +
        `existing node retains previous content. Delete the Plan node manually to force a re-index.`,
      );
    }
    if (added === 0) result.skipped++;
  }

  return result;
}

interface PlanRow {
  id: string;
  updatedAt: string;
}

function loadExistingPlans(db: Db): Map<string, PlanRow> {
  const out = new Map<string, PlanRow>();
  for (const id of db.queryByNamedType(['Plan'])) {
    const nameFieldId = db.getMapFieldId(id, 'name');
    const updatedFieldId = db.getMapFieldId(id, 'updatedAt');
    if (!nameFieldId || !updatedFieldId) continue;
    const nameNode = db.loadNode(nameFieldId);
    const updatedNode = db.loadNode(updatedFieldId);
    if (nameNode.kind !== 'atom' || nameNode.atom.kind !== 'symbol') continue;
    if (updatedNode.kind !== 'atom' || updatedNode.atom.kind !== 'symbol') continue;
    out.set(nameNode.atom.value, { id, updatedAt: updatedNode.atom.value });
  }
  return out;
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
 * Parse a plan's markdown body and resolve any references to existing DB
 * nodes. Conservative: only single-match resolutions are kept.
 */
async function resolvePlanLinks(content: string, db: Db): Promise<{
  fileRefs: { $id: string }[];
  symbolRefs: { $id: string }[];
}> {
  const filePaths = extractFilePathCandidates(content);
  const identifiers = extractIdentifierCandidates(content);

  const fileOwners = new Set<string>();
  for (const path of filePaths) {
    const owner = await resolveSingleNamedOwnerOfType(path, db, 'File');
    if (owner) fileOwners.add(owner);
  }

  const symbolOwners = new Set<string>();
  for (const ident of identifiers) {
    const owner = await resolveSingleNamedOwnerExcluding(ident, db, EXCLUDED_TYPES);
    if (owner) symbolOwners.add(owner);
  }

  return {
    fileRefs: [...fileOwners].map($id => ({ $id })),
    symbolRefs: [...symbolOwners].map($id => ({ $id })),
  };
}

const EXCLUDED_TYPES = new Set(['Location', 'Span', 'Folder', 'File', 'Plan']);

/**
 * Append `fileRefs` / `symbolRefs` to an existing Plan node's
 * `relatedFiles` / `relatedSymbols` lists, skipping duplicates.
 * Returns total items appended across both fields.
 */
function appendLinksToExistingPlan(
  db: Db,
  planId: string,
  fileRefs: { $id: string }[],
  symbolRefs: { $id: string }[],
): number {
  let added = 0;
  if (fileRefs.length > 0) {
    const listId = db.getMapFieldId(planId, 'relatedFiles');
    if (listId) added += db.appendListItemsUnique(listId, fileRefs.map(r => r.$id));
  }
  if (symbolRefs.length > 0) {
    const listId = db.getMapFieldId(planId, 'relatedSymbols');
    if (listId) added += db.appendListItemsUnique(listId, symbolRefs.map(r => r.$id));
  }
  return added;
}

/** Pull every `[label](target)` target whose path looks like a file. */
export function extractFilePathCandidates(content: string): string[] {
  const out = new Set<string>();
  for (const m of content.matchAll(MD_LINK_RE)) {
    const target = m[1]!.trim();
    if (!target) continue;
    if (/^https?:/i.test(target)) continue;        // skip URLs
    if (/^mailto:/i.test(target)) continue;
    // Anchor-only links (#section) and pure section refs aren't files.
    if (target.startsWith('#')) continue;
    // Strip any trailing anchor / line number (`foo.ts#L42`, `foo.ts:42`).
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
  // Reuse the agent-log identifier filter (PascalCase / camelCase / snake_case).
  const all = new Set<string>();
  for (const span of codeSpans) {
    for (const id of extractIdentifiers(span)) all.add(id);
  }
  return [...all];
}

/**
 * Resolve a file-path candidate (often relative) to a single File node, even
 * when the stored path is absolute. Tries exact match first, then a
 * suffix-anchored regex.
 */
async function resolveSingleNamedOwnerOfType(
  value: string, db: Db, typeName: string,
): Promise<string | null> {
  // Exact match first
  let symbolIds = await querySymbolExact(value, db);
  if (symbolIds.length === 0 && typeName === 'File') {
    // Try suffix match: absolute paths in DB ending with the candidate.
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    try { symbolIds = db.querySymbolRegex(`(^|/)${escaped}$`); }
    catch { symbolIds = []; }
  }
  if (symbolIds.length === 0) return null;
  const owners = new Set<string>();
  for (const sid of symbolIds) {
    const p = db.findNamedParent(sid);
    if (!p || p.typeName !== typeName) continue;
    owners.add(p.id);
    if (owners.size > 1) return null;
  }
  return owners.size === 1 ? [...owners][0]! : null;
}

/** Resolve `value` to its single named-type ancestor, skipping `excluded` types. */
async function resolveSingleNamedOwnerExcluding(
  value: string, db: Db, excluded: Set<string>,
): Promise<string | null> {
  const symbolIds = await querySymbolExact(value, db);
  if (symbolIds.length === 0) return null;
  const owners = new Set<string>();
  for (const sid of symbolIds) {
    const p = db.findNamedParent(sid);
    if (!p) continue;
    if (excluded.has(p.typeName)) continue;
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
