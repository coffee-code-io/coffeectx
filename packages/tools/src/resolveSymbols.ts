/**
 * Batched symbol resolver — given a list of name candidates, return their
 * matching named-type ancestor UUIDs in one tool call.
 *
 * Each candidate is looked up by exact Symbol match; every match is lifted to
 * its nearest non-hidden named-type ancestor. Ambiguity is surfaced explicitly
 * (multiple candidates → caller chooses) rather than silently dropped.
 *
 * Designed to replace N round-trips of `get_by_symbol_text` when the agent is
 * populating link arrays like `relatedSymbols` on a freshly-extracted node.
 */

import type { Db } from '@coffeectx/core';

export const description =
  'Resolve multiple symbol names to their owning named-type node UUIDs in one call. ' +
  'Use this when populating link fields like relatedSymbols or touchedSymbols and you have a list of names to attach. ' +
  'Each name is looked up as an exact Symbol value; matches are lifted to their nearest non-hidden named-type ancestor. ' +
  'For each input name the result reports zero, one, or multiple candidate ancestors — pick the right $id and pass it through { "$id": "<uuid>" } in your next upsert_entries call. ' +
  'Cheaper than calling get_by_symbol_text N times.';

export interface ResolveSymbolsParams {
  /** Symbol values to resolve. Order is preserved in the results. */
  names: string[];
  /**
   * If provided, only candidate ancestors whose typeName is in this set are
   * returned. Useful when the caller knows the link field's element type
   * (e.g. ['LspFunction', 'LspMethod'] for a relatedSymbols list).
   */
  typeNames?: string[];
}

export interface ResolveSymbolsCandidate {
  id: string;
  typeName: string;
}

export interface ResolveSymbolsMatch {
  name: string;
  /** Zero, one, or multiple matches. Caller picks. Empty array = no match. */
  candidates: ResolveSymbolsCandidate[];
}

export interface ResolveSymbolsResult {
  matches: ResolveSymbolsMatch[];
}

export function run(db: Db, p: ResolveSymbolsParams): ResolveSymbolsResult {
  const typeFilter = p.typeNames && p.typeNames.length > 0 ? new Set(p.typeNames) : null;
  const matches: ResolveSymbolsMatch[] = [];

  for (const name of p.names) {
    const symbolIds = db.querySymbolExact(name);
    const seen = new Map<string, ResolveSymbolsCandidate>();
    for (const sid of symbolIds) {
      const parent = db.findNamedParent(sid);
      if (!parent) continue;
      if (db.isHiddenNamedType(parent.typeName)) continue;
      if (typeFilter && !typeFilter.has(parent.typeName)) continue;
      if (!seen.has(parent.id)) seen.set(parent.id, { id: parent.id, typeName: parent.typeName });
    }
    matches.push({ name, candidates: [...seen.values()] });
  }

  return { matches };
}
