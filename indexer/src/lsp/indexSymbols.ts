/**
 * Walk a repository, request LSP document symbols for each source file,
 * and insert the results into the knowledge graph as typed nodes.
 *
 * After inserting, enriches existing log events with bidirectional links:
 *   FileOperation.touchedSymbols  ← all LSP symbols in the touched file
 *   UserInput.relatedSymbols      ← LSP symbols whose name appears in the message text
 *   AgentQuestion.relatedSymbols  ← same, for agent questions
 *   LspSymbol.agentEvents         ← set at insert time (file + name matches)
 */

import { readdirSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import type { Db, InsertEntry } from '@retrival-mcp/core';
import { LspClient, SymbolKind, type DocumentSymbol, type SymbolInformation } from './client.js';

// Extensions the indexer will process
const SOURCE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'mjs', 'cjs', 'jsx',
  'py', 'rs', 'go', 'java', 'cs', 'cpp', 'cc', 'c', 'rb',
]);

// Directories to skip
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '__pycache__', 'target',
]);

export interface IndexResult {
  files: number;
  nodes: number;
  errors: Array<{ file: string; error: string }>;
}

// ── LSP kind mapping ──────────────────────────────────────────────────────────

/** Map LSP SymbolKind to our named type names from code.yaml. */
function kindToTypeName(kind: SymbolKind): string | null {
  switch (kind) {
    case SymbolKind.Module:        return 'LspModule';
    case SymbolKind.Namespace:     return 'LspNamespace';
    case SymbolKind.Class:         return 'LspClass';
    case SymbolKind.Method:        return 'LspMethod';
    case SymbolKind.Property:      return 'LspProperty';
    case SymbolKind.Field:         return 'LspField';
    case SymbolKind.Constructor:   return 'LspConstructor';
    case SymbolKind.Enum:          return 'LspEnum';
    case SymbolKind.Interface:     return 'LspInterface';
    case SymbolKind.Function:      return 'LspFunction';
    case SymbolKind.Variable:      return 'LspVariable';
    case SymbolKind.Constant:      return 'LspConstant';
    case SymbolKind.EnumMember:    return 'LspEnumMember';
    case SymbolKind.TypeParameter: return 'LspTypeParameter';
    default:                       return null;
  }
}

// ── File collection ───────────────────────────────────────────────────────────

function collectFiles(rootPath: string): string[] {
  const files: string[] = [];
  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
      } else if (entry.isFile()) {
        const ext = entry.name.split('.').pop() ?? '';
        if (SOURCE_EXTENSIONS.has(ext)) files.push(full);
      }
    }
  }
  walk(rootPath);
  return files;
}

// ── Symbol flattening ─────────────────────────────────────────────────────────

interface SymbolRecord {
  typeName: string;
  name: string;
  containerName: string;
  detail: string;
  line: number;
  column: number;
}

function flattenDocumentSymbols(symbols: DocumentSymbol[], containerName: string, out: SymbolRecord[]): void {
  for (const s of symbols) {
    const typeName = kindToTypeName(s.kind);
    if (typeName) {
      out.push({ typeName, name: s.name, containerName, detail: s.detail ?? '', line: s.selectionRange.start.line, column: s.selectionRange.start.character });
    }
    if (s.children?.length) flattenDocumentSymbols(s.children, s.name, out);
  }
}

function flattenSymbolInformation(symbols: SymbolInformation[], out: SymbolRecord[]): void {
  for (const s of symbols) {
    const typeName = kindToTypeName(s.kind);
    if (typeName) {
      out.push({ typeName, name: s.name, containerName: s.containerName ?? '', detail: '', line: s.location.range.start.line, column: s.location.range.start.character });
    }
  }
}

function isDocumentSymbolArray(arr: unknown[]): arr is DocumentSymbol[] {
  return arr.length > 0 && 'selectionRange' in (arr[0] as object);
}

// ── Pre-built event indexes ────────────────────────────────────────────────────

/**
 * Information about a log event relevant for reverse linking.
 * fieldName is the map key that holds the symbol list to enrich.
 */
interface LogEventInfo {
  id: string;
  typeName: string;
  fieldName: 'touchedSymbols' | 'relatedSymbols';
}

/**
 * Build a map from file path variants → FileOperation event info.
 * All path variants (full path, basename, last-two-segment path) are indexed
 * so relative and absolute paths both match.
 */
function buildFileEventIndex(db: Db): Map<string, LogEventInfo[]> {
  const index = new Map<string, LogEventInfo[]>();
  for (const eventId of db.queryByNamedType(['FileOperation'])) {
    try {
      const node = db.loadNodeDeep(eventId, 2);
      if (node.kind !== 'map') continue;
      const pathNode = node.entries['path'];
      if (pathNode?.kind !== 'atom' || pathNode.atom.kind !== 'symbol') continue;
      const info: LogEventInfo = { id: eventId, typeName: 'FileOperation', fieldName: 'touchedSymbols' };
      for (const key of pathVariants(pathNode.atom.value)) {
        const arr = index.get(key) ?? [];
        arr.push(info);
        index.set(key, arr);
      }
    } catch { /* best-effort */ }
  }
  return index;
}

/**
 * Build a map from code identifier → [UserInput / AgentQuestion event info].
 * Identifiers are extracted from the text/question Meaning fields.
 */
function buildNameEventIndex(db: Db): Map<string, LogEventInfo[]> {
  const index = new Map<string, LogEventInfo[]>();
  const pairs: Array<{ typeName: string; fieldKey: string; resultField: 'relatedSymbols' }> = [
    { typeName: 'UserInput',      fieldKey: 'text',     resultField: 'relatedSymbols' },
    { typeName: 'AgentQuestion',  fieldKey: 'question', resultField: 'relatedSymbols' },
  ];
  for (const { typeName, fieldKey, resultField } of pairs) {
    for (const eventId of db.queryByNamedType([typeName])) {
      try {
        const node = db.loadNodeDeep(eventId, 2);
        if (node.kind !== 'map') continue;
        const field = node.entries[fieldKey];
        if (field?.kind !== 'atom' || field.atom.kind !== 'meaning') continue;
        const identifiers = extractIdentifiers(field.atom.value.text);
        const info: LogEventInfo = { id: eventId, typeName, fieldName: resultField };
        for (const ident of identifiers) {
          const arr = index.get(ident) ?? [];
          arr.push(info);
          index.set(ident, arr);
        }
      } catch { /* best-effort */ }
    }
  }
  return index;
}

/** Heuristic: extract PascalCase, camelCase, and long snake_case words from free text. */
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

function pathVariants(p: string): string[] {
  const parts = p.replace(/\\/g, '/').split('/').filter(Boolean);
  const variants: string[] = [p];
  if (parts.length >= 1) variants.push(parts[parts.length - 1]!);
  if (parts.length >= 2) variants.push(parts.slice(-2).join('/'));
  return [...new Set(variants)];
}

// ── Symbol entry builder ───────────────────────────────────────────────────────

function symbolEntry(rec: SymbolRecord, relPath: string, agentEventIds: string[]): InsertEntry {
  return {
    type: rec.typeName,
    data: {
      name: rec.name,
      containerName: rec.containerName,
      detail: rec.detail,
      location: {
        file: {
          path: relPath,
          name: basename(relPath),
          description: '',
        },
        line: String(rec.line + 1),   // LSP is 0-based
        column: String(rec.column + 1),
      },
      agentEvents: agentEventIds,
    },
  };
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Run LSP indexing over repoPath and insert all recognised symbols into db.
 * After inserting, enriches existing log events with bidirectional links.
 */
export async function indexWithLsp(
  db: Db,
  repoPath: string,
  lspCommand: string,
  lspArgs: string[],
): Promise<IndexResult> {
  const result: IndexResult = { files: 0, nodes: 0, errors: [] };

  // Build event indexes upfront so both agentEvents and reverse links can be populated.
  const fileEventIndex = buildFileEventIndex(db);
  const nameEventIndex = buildNameEventIndex(db);

  const client = await LspClient.start(lspCommand, lspArgs, repoPath);
  await new Promise(r => setTimeout(r, 500));

  const files = collectFiles(repoPath);
  result.files = files.length;

  // Accumulate reverse links: log event node ID → LSP symbol node IDs to append
  const reverseLinks = new Map<string, { info: LogEventInfo; symbolIds: string[] }>();

  for (const filePath of files) {
    const relPath = relative(repoPath, filePath);
    try {
      const rawSymbols = await client.documentSymbols(filePath);
      if (!rawSymbols.length) continue;

      const records: SymbolRecord[] = [];
      if (isDocumentSymbolArray(rawSymbols)) {
        flattenDocumentSymbols(rawSymbols as DocumentSymbol[], '', records);
      } else {
        flattenSymbolInformation(rawSymbols as SymbolInformation[], records);
      }

      if (records.length === 0) continue;

      // Collect file-level event IDs
      const fileEvents: LogEventInfo[] = [...new Map([
        ...[...(fileEventIndex.get(relPath) ?? [])].map(e => [e.id, e] as const),
        ...[...(fileEventIndex.get(basename(relPath)) ?? [])].map(e => [e.id, e] as const),
      ]).values()];
      const fileEventIds = fileEvents.map(e => e.id);

      // Build per-record agentEvents (file events + name-matched events)
      const entries = records.map(rec => {
        const nameEvents = nameEventIndex.get(rec.name) ?? [];
        const allEventIds = [...new Set([...fileEventIds, ...nameEvents.map(e => e.id)])];
        return symbolEntry(rec, relPath, allEventIds);
      });

      const insertResult = await db.insertEntries(entries);
      result.nodes += insertResult.ids.filter(id => id !== null).length;

      for (const err of insertResult.errors) {
        result.errors.push({ file: relPath, error: `[${err.path}] ${err.message}` });
      }

      // Accumulate reverse links for file-level events (touchedSymbols)
      const insertedIds = insertResult.ids.filter((id): id is string => id !== null);
      for (const info of fileEvents) {
        const entry = reverseLinks.get(info.id) ?? { info, symbolIds: [] };
        entry.symbolIds.push(...insertedIds);
        reverseLinks.set(info.id, entry);
      }

      // Accumulate reverse links for name-matched events (relatedSymbols)
      for (let i = 0; i < records.length; i++) {
        const symbolId = insertResult.ids[i];
        if (!symbolId) continue;
        const nameEvents = nameEventIndex.get(records[i]!.name) ?? [];
        for (const info of nameEvents) {
          const entry = reverseLinks.get(info.id) ?? { info, symbolIds: [] };
          entry.symbolIds.push(symbolId);
          reverseLinks.set(info.id, entry);
        }
      }
    } catch (err) {
      result.errors.push({ file: relPath, error: (err as Error).message });
    }
  }

  await client.shutdown();

  // ── Enrich log events with symbol links ─────────────────────────────────────
  for (const { info, symbolIds } of reverseLinks.values()) {
    if (symbolIds.length === 0) continue;
    try {
      const listId = db.getMapFieldId(info.id, info.fieldName);
      if (listId) db.appendListItems(listId, [...new Set(symbolIds)]);
    } catch { /* best-effort */ }
  }

  return result;
}
