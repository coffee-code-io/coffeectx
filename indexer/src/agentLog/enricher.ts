import { parseQuery, executeQuery } from '@retrival-mcp/core';
import type { QueryDb } from '@retrival-mcp/core';
import type { ClassifiedEvent } from './classifier.js';

export interface EnrichedEvent extends ClassifiedEvent {
  /** IDs of existing DB nodes that this event relates to (file, symbol, etc.) */
  linkedNodeIds: string[];
}

/**
 * For each classified event, attempt to find related nodes already in the DB.
 *
 * Strategy (recall over precision):
 * - FileOperation (path): exact Symbol match on the file path.
 * - UserInput / AgentQuestion (text): exact Symbol matches on any word that looks
 *   like a code identifier (PascalCase, camelCase, snake_case longer than 4 chars).
 * - ShellExecution: no enrichment (commands rarely map to stored graph nodes).
 */
export async function enrichEvents(
  events: ClassifiedEvent[],
  db: QueryDb,
): Promise<EnrichedEvent[]> {
  const enriched: EnrichedEvent[] = [];

  for (const event of events) {
    const linkedNodeIds: string[] = [];

    try {
      if ((event.kind === 'file_create' || event.kind === 'file_edit') && event.path) {
        // Look for File/Location nodes whose path symbol matches exactly.
        const ids = await querySymbol(event.path, db);
        linkedNodeIds.push(...ids);
      } else if ((event.kind === 'user_input' || event.kind === 'agent_question')) {
        const text = event.text ?? event.question ?? '';
        const identifiers = extractIdentifiers(text);
        for (const ident of identifiers) {
          const ids = await querySymbol(ident, db);
          linkedNodeIds.push(...ids);
        }
      }
    } catch {
      // enrichment is best-effort — never block indexing
    }

    enriched.push({ ...event, linkedNodeIds: dedup(linkedNodeIds) });
  }

  return enriched;
}

async function querySymbol(value: string, db: QueryDb): Promise<string[]> {
  try {
    const q = parseQuery(`Symbol "${escapeStr(value)}"`);
    return await executeQuery(q, db);
  } catch {
    return [];
  }
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
function extractIdentifiers(text: string): string[] {
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

function dedup(ids: string[]): string[] {
  return Array.from(new Set(ids));
}
