/**
 * Plan-extraction helpers shared by:
 *   - `indexPlans.ts` (disk-watched Claude plans under ~/.claude/plans/);
 *   - the agent-log pipeline's codex provider, which extracts plans from
 *     `<proposed_plan>...</proposed_plan>` markup inside assistant messages.
 *
 * Anything that takes a markdown plan body and converts it into a `Plan`
 * node's `{title, relatedFiles, relatedSymbols}` triplet lives here so both
 * call sites stay in sync.
 */

import { parseQuery, executeQuery } from '@coffeectx/core';
import type { Db } from '@coffeectx/core';
import { extractIdentifiers } from '../agentLog/enricher.js';

/** Markdown link target — captures the URL/path inside `[label](target)`. */
const MD_LINK_RE = /\[[^\]]*\]\(([^)\s]+)/g;
/** Backtick-fenced inline code — captures whatever's between single backticks. */
const INLINE_CODE_RE = /`([^`\n]{2,})`/g;

/** `Plan.relatedSymbols` accepts these types only (matches AnyLspSymbol). */
const LSP_SYMBOL_TYPES = new Set([
  'LspModule', 'LspNamespace', 'LspClass', 'LspInterface',
  'LspEnum', 'LspFunction', 'LspMethod', 'LspConstructor',
]);

/** First-line H1 (`# title`) or the first non-empty trimmed line, capped at 200 chars. */
export function extractTitle(content: string): string | null {
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

export interface PlanLinks {
  filePaths: string[];
  symbolRefs: { $id: string }[];
}

/**
 * Parse a plan's markdown body and resolve references the graph can
 * represent at write time:
 *   - File paths land as plain Symbol strings in `Plan.relatedFiles`.
 *   - Identifier candidates (inline-code tokens) resolve to LSP symbol ids
 *     — single non-excluded ancestor or drop.
 */
export async function resolvePlanLinks(content: string, db: Db): Promise<PlanLinks> {
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
