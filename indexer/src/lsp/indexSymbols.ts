/**
 * Walk a repository, request LSP document symbols for each source file,
 * and insert the results into the knowledge graph as typed nodes.
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

/** Collect all source files under rootPath recursively. */
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

/**
 * Build a map from file path (absolute or relative) → [FileOperation event node IDs].
 * Used to pre-populate `agentEvents` on LSP symbols with events that touched their file.
 */
function buildFileEventIndex(db: Db): Map<string, string[]> {
  const index = new Map<string, string[]>();
  const eventIds = db.queryByNamedType(['FileOperation']);
  for (const eventId of eventIds) {
    try {
      const node = db.loadNodeDeep(eventId, 2);
      if (node.kind !== 'map') continue;
      const pathNode = node.entries['path'];
      if (pathNode?.kind === 'atom' && pathNode.atom.kind === 'symbol') {
        const p = pathNode.atom.value;
        // Index by full path, basename, and last two path segments for flexible matching
        for (const key of pathVariants(p)) {
          const arr = index.get(key) ?? [];
          arr.push(eventId);
          index.set(key, arr);
        }
      }
    } catch {
      // best-effort
    }
  }
  return index;
}

function pathVariants(p: string): string[] {
  const parts = p.replace(/\\/g, '/').split('/').filter(Boolean);
  const variants: string[] = [p];
  if (parts.length >= 1) variants.push(parts[parts.length - 1]!);
  if (parts.length >= 2) variants.push(parts.slice(-2).join('/'));
  return [...new Set(variants)];
}

/** Build an InsertEntry for a single LSP symbol. */
function symbolEntry(rec: SymbolRecord, relPath: string, fileEventIds: string[]): InsertEntry {
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
      agentEvents: fileEventIds,
    },
  };
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Run LSP indexing over repoPath and insert all recognised symbols into db.
 */
export async function indexWithLsp(
  db: Db,
  repoPath: string,
  lspCommand: string,
  lspArgs: string[],
): Promise<IndexResult> {
  const result: IndexResult = { files: 0, nodes: 0, errors: [] };

  // Build file→event index before starting LSP so agentEvents can be populated.
  const fileEventIndex = buildFileEventIndex(db);

  const client = await LspClient.start(lspCommand, lspArgs, repoPath);
  await new Promise(r => setTimeout(r, 500));

  const files = collectFiles(repoPath);
  result.files = files.length;

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

      // Collect event IDs for this file across all path variants
      const fileEventIds = [...new Set([
        ...(fileEventIndex.get(relPath) ?? []),
        ...(fileEventIndex.get(basename(relPath)) ?? []),
      ])];

      const entries = records.map(rec => symbolEntry(rec, relPath, fileEventIds));
      const insertResult = await db.insertEntries(entries);
      result.nodes += insertResult.ids.filter(id => id !== null).length;

      for (const err of insertResult.errors) {
        result.errors.push({ file: relPath, error: `[${err.path}] ${err.message}` });
      }
    } catch (err) {
      result.errors.push({ file: relPath, error: (err as Error).message });
    }
  }

  await client.shutdown();
  return result;
}
