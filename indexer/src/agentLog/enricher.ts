import { parseQuery, executeQuery } from '@coffeectx/core';
import type { Db } from '@coffeectx/core';
import type { ClassifiedEvent } from './classifier.js';

// After the directory-schema flatten, the only remaining "container" types
// (entities one shouldn't link to as if they were code symbols) are Plan and
// AgentSession. File/Folder/Location/Span are gone — `file_path` is now a
// plain field on LspSymbol, not a separate node.
const OWNED_TYPES = new Set(['Plan', 'AgentSession']);

export interface EnrichedEvent extends ClassifiedEvent {
  /**
   * Existing LSP-symbol nodes this event relates to, resolved conservatively:
   * each identifier extracted from the event's text is keyed to the *single*
   * unique LSP ancestor of its matching Symbol atom, AND that ancestor must
   * live in a file in the event's file-context (the Edit/Write boundary the
   * event is "about" in its session). Wrapped as `{ $id }` so callers can
   * splice straight into a `List<AnyLspSymbol>` field of an InsertEntry.
   *
   * FileOperation events leave this empty — the LSP indexer's reverse pass
   * populates `touchedSymbols` at the file-path level instead.
   */
  linkedRefs: { $id: string }[];
}

/**
 * For each classified event, find existing named-type nodes it relates to.
 *
 * Conservative strategy: each candidate identifier (a file path for FileOps,
 * a PascalCase/camelCase/snake_case token in text otherwise) is looked up by
 * exact Symbol match. If the matching Symbol atom has exactly one named-type
 * ancestor (skipping container types like Location/Folder), we keep that
 * ancestor's UUID. Ambiguous matches are dropped — skill agents can resolve
 * them later with full type context.
 *
 * - FileOperation: file-path lookup → matches go to `linkedFileRefs`.
 * - UserInput / AgentQuestion / AgentMessage / AgentSummary: identifier
 *   extraction from text → matches go to `linkedRefs`.
 * - ShellExecution: no enrichment.
 */
export interface EnrichProgressOptions {
  /** Called once per event after enrichment; lets callers report progress. */
  onTick?: (i: number, total: number) => void;
  /**
   * Per-event file-context allowlist, keyed by `event.uuid` (the source uuid
   * from the provider, not the inserted node id). When set for an event, the
   * enricher restricts candidate LSP ancestors to symbols whose `file_path`
   * field is in the allowed set. Events absent from this map are NOT enriched
   * (they get an empty `linkedRefs` array).
   */
  fileContextByUuid?: Map<string, string[]>;
}

export async function enrichEvents(
  events: ClassifiedEvent[],
  db: Db,
  progressOpts: EnrichProgressOptions = {},
): Promise<EnrichedEvent[]> {
  const enriched: EnrichedEvent[] = [];
  const fileCtx = progressOpts.fileContextByUuid;

  // Tiny memo so we don't repeat lspSymbolsByFilePaths for the same allowed-set
  // across events in the same session.
  const allowedCache = new Map<string, Set<string>>();
  const allowedFor = (paths: string[]): Set<string> => {
    const key = paths.slice().sort().join('');
    let s = allowedCache.get(key);
    if (!s) {
      s = new Set(db.lspSymbolsByFilePaths(paths));
      allowedCache.set(key, s);
    }
    return s;
  };

  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    progressOpts.onTick?.(i, events.length);
    const linkedRefs: { $id: string }[] = [];

    try {
      // Skip path-only events — the LSP enricher handles touchedSymbols.
      if (event.kind === 'shell_exec' || event.kind === 'file_create' || event.kind === 'file_edit') {
        enriched.push({ ...event, linkedRefs });
        continue;
      }

      // No file context → no relatedSymbols. Sessions without any Edit/Write
      // produce no entries here (per the user-approved heuristic).
      const allowedPaths = fileCtx?.get(event.uuid);
      if (!allowedPaths || allowedPaths.length === 0) {
        enriched.push({ ...event, linkedRefs });
        continue;
      }
      const allowedSymbols = allowedFor(allowedPaths);
      if (allowedSymbols.size === 0) {
        enriched.push({ ...event, linkedRefs });
        continue;
      }

      const text =
        event.kind === 'agent_question'
          ? (event.question ?? '')
          : (event.text ?? '');
      if (text) {
        const identifiers = extractIdentifiers(text);
        const seen = new Set<string>();
        for (const ident of identifiers) {
          const owner = await resolveSingleNamedOwner(ident, db, allowedSymbols);
          if (owner && !seen.has(owner)) {
            seen.add(owner);
            linkedRefs.push({ $id: owner });
          }
        }
      }
    } catch {
      // enrichment is best-effort — never block indexing
    }

    enriched.push({ ...event, linkedRefs });
  }

  return enriched;
}

/**
 * Look up `value` as an exact Symbol, then resolve each match to its single
 * named-type ancestor — additionally requiring that the ancestor's node id is
 * in `allowedSymbols` (i.e. the symbol lives in a file the event is about).
 * Returns the ancestor UUID iff exactly one such match exists; ambiguity → drop.
 */
async function resolveSingleNamedOwner(
  value: string,
  db: Db,
  allowedSymbols: Set<string>,
): Promise<string | null> {
  let symbolIds: string[];
  try {
    const q = parseQuery(`Symbol "${escapeStr(value)}"`);
    symbolIds = await executeQuery(q, db);
  } catch {
    return null;
  }
  if (symbolIds.length === 0) return null;

  const owners = new Set<string>();
  for (const sid of symbolIds) {
    const parent = db.findNamedParent(sid);
    if (!parent) continue;
    if (OWNED_TYPES.has(parent.typeName)) continue;
    if (!allowedSymbols.has(parent.id)) continue;   // not in this event's file context
    owners.add(parent.id);
    if (owners.size > 1) return null; // ambiguous within the allowed set — drop
  }
  return owners.size === 1 ? [...owners][0]! : null;
}

/** Escape double-quotes so the value is safe inside a Symbol "..." query clause. */
function escapeStr(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Extract potential code identifiers from free text.
 * Heuristic: words that are PascalCase, camelCase, or snake_case with 5+ chars,
 * and don't look like common English words or log noise.
 */
export function extractIdentifiers(text: string): string[] {
  const WORD_RE = /\b([A-Z][a-zA-Z0-9]{3,}|[a-z][a-zA-Z0-9]{3,}(?:[A-Z][a-zA-Z0-9]*)+|[a-z][a-z0-9_]{4,})\b/g;
  const STOP_WORDS = new Set([
    'true', 'false', 'null', 'undefined', 'string', 'number', 'boolean',
    'const', 'function', 'interface', 'export', 'import', 'return', 'async',
    'await', 'class', 'extends', 'implements', 'type', 'enum', 'object',
  ]);
  const found = new Set<string>();
  for (const [, word] of text.matchAll(WORD_RE)) {
    if (!STOP_WORDS.has(word)) found.add(word);
  }
  return Array.from(found);
}
