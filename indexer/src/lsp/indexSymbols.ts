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

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Db, DeepNode, InsertEntry } from '@coffeectx/core';
import { LspClient, SymbolKind, type DocumentSymbol, type SymbolInformation } from './client.js';
import {
  type FileHashStore,
  hasRepoChanged,
  markRepoIndexed,
  saveFileHashes,
} from '../fileHashes.js';
import {
  extractIdentifierCandidates,
} from '../plans/indexPlans.js';
import { Progress } from '../jobs/progress.js';

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
  skipped: boolean;
  errors: Array<{ file: string; error: string }>;
}

export interface IndexWithLspOptions {
  /** If provided, skip indexing if repo source files haven't changed; updated after indexing. */
  hashes?: FileHashStore;
}

// ── LSP kind mapping ──────────────────────────────────────────────────────────

/**
 * Map LSP SymbolKind to our named type names from code.yaml.
 *
 * Property / Field / Variable are intentionally not given their own node type:
 *   - Property + Field names are folded into the parent class/interface's
 *     `members` symbol list (see `collectMemberNames` below) — that gives us
 *     the "what fields does X have" question without one node per leaf.
 *   - Variable bindings are almost always either local-scope (already
 *     filtered) or low-value module-level mutables; if it matters, it usually
 *     surfaces as an LspConstant or LspFunction.
 */
function kindToTypeName(kind: SymbolKind): string | null {
  switch (kind) {
    case SymbolKind.Module:        return 'LspModule';
    case SymbolKind.Namespace:     return 'LspNamespace';
    case SymbolKind.Class:         return 'LspClass';
    case SymbolKind.Method:        return 'LspMethod';
    case SymbolKind.Constructor:   return 'LspConstructor';
    case SymbolKind.Enum:          return 'LspEnum';
    case SymbolKind.Interface:     return 'LspInterface';
    case SymbolKind.Function:      return 'LspFunction';
    case SymbolKind.Constant:      return 'LspConstant';
    case SymbolKind.EnumMember:    return 'LspEnumMember';
    case SymbolKind.TypeParameter: return 'LspTypeParameter';
    // SymbolKind.Property, SymbolKind.Field, SymbolKind.Variable — see note above.
    default:                       return null;
  }
}

/** True iff this symbol kind is a class/interface that owns a `members` list. */
function isMemberContainer(kind: SymbolKind): boolean {
  return kind === SymbolKind.Class || kind === SymbolKind.Interface;
}

/** True iff this child symbol is a leaf field/property we want to roll up. */
function isMemberLeaf(kind: SymbolKind): boolean {
  return kind === SymbolKind.Property || kind === SymbolKind.Field;
}

// ── File collection ───────────────────────────────────────────────────────────

/** Read .coffeeignore from the repo root and return a set of directory names to skip. */
function loadCoffeeignore(rootPath: string): Set<string> {
  const ignorePath = join(rootPath, '.coffeeignore');
  if (!existsSync(ignorePath)) return new Set();
  return new Set(
    readFileSync(ignorePath, 'utf-8')
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0 && !l.startsWith('#')),
  );
}

function collectFiles(rootPath: string): string[] {
  const extraSkip = loadCoffeeignore(rootPath);
  const files: string[] = [];
  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !extraSkip.has(entry.name)) walk(full);
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
  /** Populated for LspClass / LspInterface — names of owned property/field leaves. */
  members?: string[];
}

/**
 * Kinds whose body contains local-scope symbols. Variables, constants, and
 * nested functions declared inside them are implementation details — they
 * pollute the graph (every `const x = ...` inside a function gets indexed)
 * without adding query value.
 */
const FUNCTION_LIKE_KINDS = new Set<SymbolKind>([
  SymbolKind.Function,
  SymbolKind.Method,
  SymbolKind.Constructor,
]);

/** Kinds we drop when their containing scope is a function-like. */
const LOCAL_SCOPE_NOISE_KINDS = new Set<SymbolKind>([
  SymbolKind.Variable,
  SymbolKind.Constant,
  SymbolKind.Function,   // nested / arrow functions assigned to a var inside another function
]);

/**
 * Anonymous-symbol names produced by some language servers (`<anonymous>`,
 * `<function>`, `<lambda>`, `()`, or just empty). These are lambdas / IIFEs /
 * synthesised symbols that can't be referenced by name.
 */
const ANONYMOUS_NAME_RE = /^<[^>]*>$|^\(\)$|^$/;

/**
 * TypeScript LSP names inline callbacks passed to `.map`/`.filter`/`.find`/
 * `.catch`/`.then`/etc. as e.g. `arr.map() callback`, `reg('exact') callback`.
 * They aren't independently referenceable, and the trailing ` callback` form
 * (preceded by `)` or whitespace) doesn't collide with real symbol names like
 * `useCallback` or `registerCallback`.
 */
const SYNTHETIC_CALLBACK_RE = /(?:\)|\s)callback$/i;

function isAnonymous(name: string): boolean {
  const t = name.trim();
  return ANONYMOUS_NAME_RE.test(t) || SYNTHETIC_CALLBACK_RE.test(t);
}

function flattenDocumentSymbols(
  symbols: DocumentSymbol[],
  containerName: string,
  out: SymbolRecord[],
  insideFunction = false,
): void {
  for (const s of symbols) {
    const typeName = kindToTypeName(s.kind);
    const drop =
      !typeName ||
      isAnonymous(s.name) ||
      (insideFunction && LOCAL_SCOPE_NOISE_KINDS.has(s.kind));
    if (!drop) {
      const record: SymbolRecord = {
        typeName: typeName!,
        name: s.name,
        containerName,
        detail: s.detail ?? '',
        line: s.selectionRange.start.line,
        column: s.selectionRange.start.character,
      };
      // For classes / interfaces, fold direct Property/Field children into a
      // `members` symbol list so we don't emit one node per leaf field.
      if (isMemberContainer(s.kind) && s.children?.length) {
        const members = collectMemberNames(s.children);
        if (members.length > 0) record.members = members;
      }
      out.push(record);
    }
    if (s.children?.length) {
      const childInside = insideFunction || FUNCTION_LIKE_KINDS.has(s.kind);
      flattenDocumentSymbols(s.children, s.name, out, childInside);
    }
  }
}

/**
 * Pick up the names of direct Property/Field children. Anonymous and
 * computed-name leaves are dropped so the list stays semantically clean.
 */
function collectMemberNames(children: DocumentSymbol[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const c of children) {
    if (!isMemberLeaf(c.kind)) continue;
    if (isAnonymous(c.name)) continue;
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    out.push(c.name);
  }
  return out;
}

function flattenSymbolInformation(symbols: SymbolInformation[], out: SymbolRecord[]): void {
  // SymbolInformation is a flat list (older LSP protocol) — we don't have a
  // tree to inspect, so only the anonymous-name filter applies. Locals from
  // inside functions also tend to be elided by servers that emit this shape.
  for (const s of symbols) {
    const typeName = kindToTypeName(s.kind);
    if (!typeName) continue;
    if (isAnonymous(s.name)) continue;
    out.push({
      typeName,
      name: s.name,
      containerName: s.containerName ?? '',
      detail: '',
      line: s.location.range.start.line,
      column: s.location.range.start.character,
    });
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
 * Build a map from code identifier → event info. The single source of truth
 * for the LSP reverse-pass linking; the old file-path-keyed bulk index is
 * gone — every event-type now goes through "identifier name appears in the
 * event's text AND the LSP symbol lives in a file from the event's
 * file-context."
 *
 * Event sources and their per-event file-context:
 *   UserInput.text          / context: event_file_context table (filled by
 *   AgentQuestion.question    sessionContext from the surrounding Edits)
 *   AgentMessage.text
 *   AgentSummary.text
 *   FileOperation.content   / context: the FileOp's own `path` (single file)
 *   Plan.content            / context: union of FileOp paths from accepting
 *                                       sessions (plan_acceptances table)
 *
 * For Plans the identifier source is `extractIdentifierCandidates` (parses
 * fenced inline code from the markdown body); everything else uses the
 * generic `extractIdentifiers` regex.
 */
function buildNameEventIndex(db: Db, repoPath: string): {
  index: Map<string, LogEventInfo[]>;
  contextByEvent: Map<string, Set<string>>;
} {
  const index = new Map<string, LogEventInfo[]>();
  const contextByEvent = new Map<string, Set<string>>();
  const repoPrefix = repoPath.endsWith('/') ? repoPath : `${repoPath}/`;

  const push = (key: string, info: LogEventInfo) => {
    const arr = index.get(key) ?? [];
    arr.push(info);
    index.set(key, arr);
  };
  const addContext = (eventId: string, raw: string) => {
    if (!raw) return;
    const s = contextByEvent.get(eventId) ?? new Set<string>();
    s.add(raw);
    if (raw.startsWith(repoPrefix)) s.add(raw.slice(repoPrefix.length));
    contextByEvent.set(eventId, s);
  };
  /** Extract the value of an atom field regardless of symbol vs meaning. */
  const atomText = (n: DeepNode | undefined): string | null => {
    if (!n || n.kind !== 'atom') return null;
    if (n.atom.kind === 'symbol') return n.atom.value;
    if (n.atom.kind === 'meaning') return n.atom.value.text;
    return null;
  };

  // 1. Text-bearing event types (UserInput / AgentQuestion / AgentMessage /
  //    AgentSummary). File-context comes from event_file_context.
  const textSources: Array<{ typeName: string; fieldKey: string; fieldName: 'relatedSymbols' }> = [
    { typeName: 'UserInput',     fieldKey: 'text',     fieldName: 'relatedSymbols' },
    { typeName: 'AgentQuestion', fieldKey: 'question', fieldName: 'relatedSymbols' },
    { typeName: 'AgentMessage',  fieldKey: 'text',     fieldName: 'relatedSymbols' },
    { typeName: 'AgentSummary',  fieldKey: 'text',     fieldName: 'relatedSymbols' },
  ];
  for (const { typeName, fieldKey, fieldName } of textSources) {
    for (const eventId of db.queryByNamedType([typeName])) {
      try {
        const node = db.loadNodeDeep(eventId, 2);
        if (node.kind !== 'map') continue;
        const text = atomText(node.entries[fieldKey]);
        if (!text) continue;
        const info: LogEventInfo = { id: eventId, typeName, fieldName };
        for (const ident of extractIdentifiers(text)) push(ident, info);
        for (const path of db.getEventFileContext(eventId)) addContext(eventId, path);
      } catch { /* best-effort */ }
    }
  }

  // 2. FileOperations. Identifiers come from `content` (full Write/Edit
  //    payload). File-context is the FileOp's own `path` — same path as the
  //    LSP loop is iterating, so a name match is a touchedSymbol iff the
  //    symbol's `name` appears in the edit's content.
  for (const eventId of db.queryByNamedType(['FileOperation'])) {
    try {
      const node = db.loadNodeDeep(eventId, 2);
      if (node.kind !== 'map') continue;
      const content = atomText(node.entries['content']);
      const path = atomText(node.entries['path']);
      if (!path) continue;
      const info: LogEventInfo = { id: eventId, typeName: 'FileOperation', fieldName: 'touchedSymbols' };
      if (content) for (const ident of extractIdentifiers(content)) push(ident, info);
      addContext(eventId, path);
    } catch { /* best-effort */ }
  }

  // 3. Plans. Identifiers from inline-code spans in the markdown body.
  //    File-context = union of FileOperation paths across all accepting
  //    sessions (plan_acceptances). A plan with no acceptances should have
  //    been skipped at index time; here it would just produce no context →
  //    no symbol links.
  for (const planId of db.queryByNamedType(['Plan'])) {
    try {
      const node = db.loadNodeDeep(planId, 2);
      if (node.kind !== 'map') continue;
      const content = atomText(node.entries['content']);
      const slug = atomText(node.entries['name']);
      if (!content || !slug) continue;
      const info: LogEventInfo = { id: planId, typeName: 'Plan', fieldName: 'relatedSymbols' };
      for (const ident of extractIdentifierCandidates(content)) push(ident, info);
      // File-context derives from the accepting sessions' FileOperations
      // (plan_acceptances → AgentSession → FileOperation.path). This is the
      // narrower, project-scoped alternative to parsing paths out of the
      // plan markdown directly.
      for (const path of db.getPlanFilePaths(slug)) addContext(planId, path);
    } catch { /* best-effort */ }
  }

  return { index, contextByEvent };
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


// ── Symbol entry builder ───────────────────────────────────────────────────────

function symbolEntry(rec: SymbolRecord, relPath: string, agentEventIds: string[]): InsertEntry {
  const data: Record<string, unknown> = {
    name: rec.name,
    containerName: rec.containerName,
    detail: rec.detail,
    file_path: relPath,
    line: String(rec.line + 1),    // LSP is 0-based; stored as a Symbol string
    column: String(rec.column + 1),
    agentEvents: agentEventIds,
  };
  // LspClass / LspInterface always carry a `members` list (possibly empty);
  // other types omit it — the YAML schema doesn't declare it for them.
  if (rec.typeName === 'LspClass' || rec.typeName === 'LspInterface') {
    data['members'] = rec.members ?? [];
  }
  return { type: rec.typeName, data };
}

// ── Existing-symbol deduplication ────────────────────────────────────────────

const LSP_TYPES = [
  'LspModule', 'LspNamespace', 'LspClass', 'LspMethod',
  'LspConstructor', 'LspEnum', 'LspInterface', 'LspFunction',
  'LspConstant', 'LspEnumMember', 'LspTypeParameter',
];

/**
 * Build a set of keys for all LSP symbol nodes already in the DB.
 * Key format: "<typeName>:<relPath>:<name>:<line>"
 * Used to skip symbols that are already indexed so re-runs are idempotent.
 */
function symValue(db: Db, nodeId: string): string | null {
  const n = db.loadNode(nodeId);
  return n.kind === 'atom' && n.atom.kind === 'symbol' ? n.atom.value : null;
}

function buildExistingSymbolKeys(db: Db): Set<string> {
  const keys = new Set<string>();
  const ids = db.queryByNamedType(LSP_TYPES);
  for (const id of ids) {
    try {
      const typeName = db.getNodeTypeName(id);
      if (!typeName) continue;
      const nameFieldId = db.getMapFieldId(id, 'name');
      const pathFieldId = db.getMapFieldId(id, 'file_path');
      const lineFieldId = db.getMapFieldId(id, 'line');
      if (!nameFieldId || !pathFieldId || !lineFieldId) continue;
      const name = symValue(db, nameFieldId);
      const path = symValue(db, pathFieldId);
      const line = symValue(db, lineFieldId);
      if (!name || !path || !line) continue;
      keys.add(`${typeName}:${path}:${name}:${line}`);
    } catch {
      // skip unloadable nodes
    }
  }
  return keys;
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
  options: IndexWithLspOptions = {},
): Promise<IndexResult> {
  const { hashes } = options;
  const result: IndexResult = { files: 0, nodes: 0, skipped: false, errors: [] };

  const files = collectFiles(repoPath);

  if (hashes && !hasRepoChanged(repoPath, hashes, files)) {
    result.skipped = true;
    result.files = files.length;
    return result;
  }

  // Build event indexes upfront so both agentEvents and reverse links can be
  // populated. Everything goes through the name-keyed index now — the old
  // file-keyed bulk index was the source of FileOperation over-linking and
  // is gone.
  const { index: nameEventIndex, contextByEvent: nameEventFileCtx } = buildNameEventIndex(db, repoPath);

  // Pre-load existing symbol keys so re-runs don't create duplicate nodes.
  const existingSymbolKeys = buildExistingSymbolKeys(db);

  result.files = files.length;

  const client = await LspClient.start(lspCommand, lspArgs, repoPath);
  await new Promise(r => setTimeout(r, 500));

  // Accumulate reverse links: log event node ID → LSP symbol node IDs to append
  const reverseLinks = new Map<string, { info: LogEventInfo; symbolIds: string[] }>();

  const progress = new Progress('lsp', files.length);

  for (let idx = 0; idx < files.length; idx++) {
    const filePath = files[idx]!;
    const relPath = relative(repoPath, filePath);
    progress.tick(idx, relPath);
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

      // Build per-record agentEvents (name-matched events filtered by the
      // event's file_context), skipping symbols already present in the DB
      // (idempotent re-runs).
      const entries = records
        .filter(rec => {
          const lineStr = String(rec.line + 1);
          return !existingSymbolKeys.has(`${rec.typeName}:${relPath}:${rec.name}:${lineStr}`);
        })
        .map(rec => {
          const nameEvents = (nameEventIndex.get(rec.name) ?? []).filter(info =>
            nameEventFileCtx.get(info.id)?.has(relPath),
          );
          const allEventIds = [...new Set(nameEvents.map(e => e.id))];
          return symbolEntry(rec, relPath, allEventIds);
        });

      if (entries.length === 0) continue;
      const insertResult = await db.insertEntries(entries);
      result.nodes += insertResult.ids.filter(id => id !== null).length;

      for (const err of insertResult.errors) {
        result.errors.push({ file: relPath, error: `[${err.path}] ${err.message}` });
      }

      // Accumulate reverse links for name-matched events — only when the
      // event's file_context includes the LSP symbol's file path. This is
      // what gives FileOperation.touchedSymbols (event = FileOp, context =
      // its own path) the same narrow shape that text events get.
      for (let i = 0; i < records.length; i++) {
        const symbolId = insertResult.ids[i];
        if (!symbolId) continue;
        const nameEvents = nameEventIndex.get(records[i]!.name) ?? [];
        for (const info of nameEvents) {
          if (!nameEventFileCtx.get(info.id)?.has(relPath)) continue;
          const entry = reverseLinks.get(info.id) ?? { info, symbolIds: [] };
          entry.symbolIds.push(symbolId);
          reverseLinks.set(info.id, entry);
        }
      }
    } catch (err) {
      result.errors.push({ file: relPath, error: (err as Error).message });
    }
  }

  progress.done(`${result.nodes} nodes inserted`);
  await client.shutdown();

  // ── Enrich log events with symbol links ─────────────────────────────────────
  const linkTargets = [...reverseLinks.values()].filter(v => v.symbolIds.length > 0);
  if (linkTargets.length > 0) {
    const linkProgress = new Progress('lsp:reverse-links', linkTargets.length);
    for (let i = 0; i < linkTargets.length; i++) {
      const { info, symbolIds } = linkTargets[i]!;
      linkProgress.tick(i, `${info.typeName} ${info.id.slice(0, 8)} (+${symbolIds.length})`);
      try {
        const listId = db.getMapFieldId(info.id, info.fieldName);
        if (listId) db.appendListItemsUnique(listId, symbolIds);
      } catch { /* best-effort */ }
    }
    linkProgress.done();
  }

  if (hashes) {
    markRepoIndexed(repoPath, hashes, files);
    saveFileHashes(hashes);
  }

  // Bump every event node that's been "considered" by this LSP run from
  // `extracted` to `linked`. We bump unconditionally — `linked` means "LSP
  // has done its pass over this node", not "LSP found something". Without
  // this, events with no matching symbols would sit at `extracted` forever
  // and skill jobs that gate on `linked` would never see them.
  bumpEventsToLinked(db);

  return result;
}

const LINKABLE_EVENT_TYPES = [
  'UserInput', 'AgentQuestion', 'AgentMessage', 'AgentSummary',
  'FileOperation', 'ShellExecution', 'Plan',
];

function bumpEventsToLinked(db: Db): void {
  let bumped = 0;
  for (const typeName of LINKABLE_EVENT_TYPES) {
    for (const eventId of db.queryByNamedType([typeName])) {
      // `extracted` is the initial state for these types; anything else
      // (already `linked`, or absent state machine) is left alone.
      if (db.getNodeState(eventId) === 'extracted') {
        try {
          db.setNodeState(eventId, 'linked');
          bumped++;
        } catch (err) {
          // Defensive: a missing state machine row would throw here; we'd
          // rather log and continue than fail the whole LSP run.
          console.warn(`[indexSymbols] setNodeState failed on ${typeName} ${eventId}: ${(err as Error).message}`);
        }
      }
    }
  }
  if (bumped > 0) console.log(`[indexSymbols] bumped ${bumped} event nodes to 'linked'`);
}
