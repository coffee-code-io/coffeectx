/**
 * Identifier extractor used by the Plans indexer to mine fenced-code
 * tokens out of plan markdown. Span ↔ LSP linking lives elsewhere and
 * does not call this — text-level name matching is no longer how agent
 * events resolve to LSP symbols.
 */

const WORD_RE = /\b([A-Z][a-zA-Z0-9]{3,}|[a-z][a-zA-Z0-9]{3,}(?:[A-Z][a-zA-Z0-9]*)+|[a-z][a-z0-9_]{4,})\b/g;
const STOP_WORDS = new Set([
  'true', 'false', 'null', 'undefined', 'string', 'number', 'boolean',
  'const', 'function', 'interface', 'export', 'import', 'return', 'async',
  'await', 'class', 'extends', 'implements', 'type', 'enum', 'object',
]);

export function extractIdentifiers(text: string): string[] {
  const found = new Set<string>();
  for (const [, word] of text.matchAll(WORD_RE)) {
    if (!STOP_WORDS.has(word)) found.add(word);
  }
  return Array.from(found);
}
