/**
 * Render a Span as a single Markdown document with XML-like section tags.
 *
 * This is the input shape the unified per-Span indexer agent receives — a
 * deliberate replacement for the old JSON-event batches. The format trades
 * machine-readability for readability the LLM can reason over: a header,
 * grouped "created / updated / removed" symbol summary, per-symbol blocks
 * with diff-or-body, full plan content, and a logs section with no
 * timestamps / ids / file-op noise.
 *
 * Determinism: same input → byte-identical output. No `Date.now()`,
 * `Math.random()`, or UUID generation; map iteration is sorted by key.
 *
 * Used by:
 *   - `runSpanIndexer` (indexer/src/agentRun) — single prompt per Span.
 *   - `load-node --format span-md` CLI — debug preview.
 *   - Future MCP `loadSpan` tool (not yet wired).
 */

import { createTwoFilesPatch } from 'diff';
import type { Db } from './db.js';
import type { DeepNode } from './types.js';

const FUNCTION_LIKE = new Set(['LspFunction', 'LspMethod', 'LspConstructor']);
const CONTAINER_LIKE = new Set(['LspClass', 'LspInterface', 'LspModule', 'LspNamespace', 'LspEnum']);
const SHELL_CMD_CROP = 200;

export interface SpanMdOptions {
  /** Diff context window (lines on either side). Default 3. */
  contextLines?: number;
  /** Max chars of a ShellExecution.command before truncation. Default 200. */
  shellCropLimit?: number;
}

export function formatSpanMd(db: Db, spanId: string, opts: SpanMdOptions = {}): string {
  const context = opts.contextLines ?? 3;
  const shellLimit = opts.shellCropLimit ?? SHELL_CMD_CROP;

  const span = db.loadNodeDeep(spanId, 2);
  if (span.kind !== 'map' || span.typeName !== 'Span') {
    throw new Error(`formatSpanMd: ${spanId} is not a Span (typeName=${span.kind === 'map' ? span.typeName : span.kind})`);
  }

  const sessionId = atomSymbol(span.entries['sessionId']);
  const startedAt = parseMs(atomSymbol(span.entries['startedAt']));
  const kind = atomSymbol(span.entries['kind']);

  const parts: string[] = [];
  parts.push(renderHeader(spanId, sessionId, kind));

  const symbolIds = listOfRefs(span.entries['touchedSymbols']);
  const buckets = bucketSymbols(db, symbolIds, startedAt);
  const summary = renderSummary(db, buckets);
  if (summary) parts.push(summary);

  const bodies = renderSymbolBodies(db, buckets, startedAt, context);
  if (bodies) parts.push(bodies);

  const planIds = listOfRefs(span.entries['touchedPlans']);
  const plansBlock = renderPlans(db, planIds);
  if (plansBlock) parts.push(plansBlock);

  const messageIds = listOfRefs(span.entries['messages']);
  parts.push(renderLogs(db, messageIds, shellLimit));

  return parts.join('\n\n') + '\n';
}

// ── Header & helpers ─────────────────────────────────────────────────────────

function renderHeader(spanId: string, sessionId: string | null, kind: string | null): string {
  const lines = [`**Span**`, `id: ${spanId}`];
  if (sessionId) lines.push(`session: ${sessionId}`);
  if (kind) lines.push(`kind: ${kind}`);
  return lines.join('\n');
}

interface BucketedSymbol {
  id: string;             // requested $id from touchedSymbols
  curId: string;          // resolved current/head id on the timeline
  typeName: string;
  name: string;
  filePath: string;
  bucket: 'created' | 'updated' | 'removed';
  prev: { id: string; version: number } | null;
  cur: DeepNode & { kind: 'map' };
}

interface SymbolBuckets {
  created: BucketedSymbol[];
  updated: BucketedSymbol[];
  removed: BucketedSymbol[];
}

function bucketSymbols(db: Db, ids: string[], startedAt: number | null): SymbolBuckets {
  const out: SymbolBuckets = { created: [], updated: [], removed: [] };
  if (startedAt == null) return out;

  // Deduplicate by timeline so we don't process the same symbol twice when
  // touchedSymbols carries multiple version ids on the same timeline.
  const seenTimelines = new Set<string>();
  const items: BucketedSymbol[] = [];

  for (const id of ids) {
    const timelineId = db.getTimelineIdOf(id);
    if (!timelineId) continue;
    if (seenTimelines.has(timelineId)) continue;
    seenTimelines.add(timelineId);

    let cur: DeepNode;
    try { cur = db.loadNodeDeep(id, 2); } catch { continue; }
    if (cur.kind !== 'map' || !cur.typeName) continue;

    const typeName = cur.typeName;
    const name = atomSymbol(cur.entries['name']) ?? '';
    const filePath = atomSymbol(cur.entries['file_path']) ?? '';
    const prevRow = db.getVersionBefore(timelineId, startedAt);
    const prev = prevRow ? { id: prevRow.id, version: prevRow.version } : null;

    // `cur.tombstone` is true in TWO semantically distinct cases:
    //  1. real deletion — a `delete + bumpVersion` v_next with empty body
    //     (no map_entries written), or
    //  2. supersession — every regular bump tombstones its v_prev row,
    //     but the row keeps its map_entries (deep-copied to v_next, not
    //     moved). That happens whenever a LATER span edits the same
    //     symbol after this span's linker already attached the now-stale
    //     v_prev id to touchedSymbols.
    // Discriminate by body presence: deletion v_next has no `name`;
    // a superseded version still does.
    const hasBody = atomSymbol(cur.entries['name']) != null;
    let bucket: 'created' | 'updated' | 'removed';
    if (cur.tombstone && !hasBody) bucket = 'removed';
    else if (prev == null) bucket = 'created';
    else bucket = 'updated';

    items.push({ id, curId: cur.id ?? id, typeName, name, filePath, bucket, prev, cur });
  }

  // Stable order: (filePath, name) ascending — deterministic by spec.
  items.sort((a, b) => (a.filePath.localeCompare(b.filePath) || a.name.localeCompare(b.name)));
  for (const it of items) out[it.bucket].push(it);
  return out;
}

function renderSummary(_db: Db, buckets: SymbolBuckets): string | null {
  const lines: string[] = [];
  if (buckets.created.length > 0) {
    lines.push(`**Created symbols**: ${buckets.created.map(s => s.name).join(', ')}`);
  }
  if (buckets.updated.length > 0) {
    lines.push(`**Updated symbols**: ${buckets.updated.map(s => s.name).join(', ')}`);
  }
  if (buckets.removed.length > 0) {
    lines.push(`**Removed symbols**: ${buckets.removed.map(s => s.name).join(', ')}`);
  }
  return lines.length > 0 ? lines.join('\n') : null;
}

// ── Per-symbol bodies ────────────────────────────────────────────────────────

function renderSymbolBodies(db: Db, buckets: SymbolBuckets, _startedAt: number | null, context: number): string | null {
  const blocks: string[] = [];
  for (const s of [...buckets.removed, ...buckets.created, ...buckets.updated]) {
    if (FUNCTION_LIKE.has(s.typeName)) blocks.push(renderFunctionLike(db, s, context));
    else if (CONTAINER_LIKE.has(s.typeName)) blocks.push(renderContainerLike(db, s));
    else blocks.push(renderGenericSymbol(s));
  }
  return blocks.length > 0 ? blocks.filter(Boolean).join('\n\n') : null;
}

function renderFunctionLike(db: Db, s: BucketedSymbol, context: number): string {
  const tag = 'function';
  const baseAttrs = `id="${s.curId}" version="${s.cur.version ?? 1}"`;
  const fileAttr = s.filePath ? ` file=${quote(s.filePath)}` : '';
  const nameAttr = s.name ? ` name=${quote(s.name)}` : '';

  if (s.bucket === 'removed') {
    return `<${tag} ${baseAttrs}${nameAttr}${fileAttr} removed/>`;
  }

  if (s.bucket === 'created') {
    const source = atomSymbol(s.cur.entries['source']) ?? '';
    const commentAttr = renderCommentAttr('comment', s.cur);
    return `<${tag} ${baseAttrs}${nameAttr}${fileAttr} new${commentAttr}>\n${source}\n</${tag}>`;
  }

  // updated
  const curSource = atomSymbol(s.cur.entries['source']) ?? '';
  const prevSource = readPrevSource(db, s.prev);
  const prevComment = readPrevComment(db, s.prev);
  const prevCommentAttr = ` prev-comment=${quote(prevComment ?? '')}`;
  const diff = unifiedDiff(prevSource, curSource, context);
  return `<${tag} ${baseAttrs}${nameAttr}${fileAttr}${prevCommentAttr}>\n${diff}</${tag}>`;
}

function renderContainerLike(db: Db, s: BucketedSymbol): string {
  const tag = tagForContainer(s.typeName);
  const baseAttrs = `id="${s.curId}" version="${s.cur.version ?? 1}"`;
  const fileAttr = s.filePath ? ` file=${quote(s.filePath)}` : '';
  const nameAttr = s.name ? ` name=${quote(s.name)}` : '';

  if (s.bucket === 'removed') {
    return `<${tag} ${baseAttrs}${nameAttr}${fileAttr} removed/>`;
  }

  const curMembers = readContainerMembers(s.cur);
  const prevMembers = readPrevContainerMembers(db, s.prev);
  const added = curMembers.filter(m => !prevMembers.includes(m));
  const removed = prevMembers.filter(m => !curMembers.includes(m));

  if (s.bucket === 'created') {
    const commentAttr = renderCommentAttr('comment', s.cur);
    const body = curMembers.length > 0
      ? curMembers.map(m => `+ ${m}`).join('\n')
      : '';
    return `<${tag} ${baseAttrs}${nameAttr}${fileAttr} new${commentAttr}>\n${body}\n</${tag}>`;
  }

  // updated
  const prevComment = readPrevComment(db, s.prev);
  const prevCommentAttr = ` prev-comment=${quote(prevComment ?? '')}`;
  const lines: string[] = [];
  for (const m of added) lines.push(`+ ${m}`);
  for (const m of removed) lines.push(`- ${m}`);
  const body = lines.length > 0 ? lines.join('\n') : '(no member changes)';
  return `<${tag} ${baseAttrs}${nameAttr}${fileAttr}${prevCommentAttr}>\n${body}\n</${tag}>`;
}

function renderGenericSymbol(s: BucketedSymbol): string {
  // Fallback for any new LSP type we don't have a specialised renderer for.
  // Render a minimal block — the agent still sees that the symbol moved.
  const tag = 'symbol';
  const baseAttrs = `id="${s.curId}" version="${s.cur.version ?? 1}" type=${quote(s.typeName)}`;
  const fileAttr = s.filePath ? ` file=${quote(s.filePath)}` : '';
  const nameAttr = s.name ? ` name=${quote(s.name)}` : '';
  if (s.bucket === 'removed') return `<${tag} ${baseAttrs}${nameAttr}${fileAttr} removed/>`;
  return `<${tag} ${baseAttrs}${nameAttr}${fileAttr} ${s.bucket}/>`;
}

function tagForContainer(typeName: string): string {
  switch (typeName) {
    case 'LspClass': return 'class';
    case 'LspInterface': return 'interface';
    case 'LspModule': return 'module';
    case 'LspNamespace': return 'namespace';
    case 'LspEnum': return 'enum';
    default: return 'class';
  }
}

// ── Prior-version readers ────────────────────────────────────────────────────

function readPrevSource(db: Db, prev: { id: string } | null): string {
  if (!prev) return '';
  try {
    const node = db.loadNodeDeep(prev.id, 1);
    if (node.kind !== 'map') return '';
    return atomSymbol(node.entries['source']) ?? '';
  } catch { return ''; }
}

function readPrevComment(db: Db, prev: { id: string } | null): string | null {
  if (!prev) return null;
  try {
    const node = db.loadNodeDeep(prev.id, 1);
    if (node.kind !== 'map') return null;
    return atomMeaning(node.entries['comment']);
  } catch { return null; }
}

function readContainerMembers(node: DeepNode & { kind: 'map' }): string[] {
  // class/module/namespace use `children` ($id refs); enum/interface use `members` (plain strings).
  const children = node.entries['children'];
  if (children && children.kind === 'list') {
    return children.items.map(it => describeChildRef(it)).filter(s => s.length > 0);
  }
  const members = node.entries['members'];
  if (members && members.kind === 'list') {
    return members.items.map(it => atomSymbolOfNode(it) ?? '').filter(s => s.length > 0);
  }
  return [];
}

function readPrevContainerMembers(db: Db, prev: { id: string } | null): string[] {
  if (!prev) return [];
  try {
    const node = db.loadNodeDeep(prev.id, 1);
    if (node.kind !== 'map') return [];
    return readContainerMembers(node);
  } catch { return []; }
}

function describeChildRef(item: DeepNode): string {
  // children is a list of LSP-symbol references; depth-1 load returns
  // `{kind:'ref', id}` for each. Render as the child's `name` if loadable.
  if (item.kind === 'ref') return item.id.slice(0, 8); // fallback when we can't expand
  if (item.kind === 'map') {
    const n = atomSymbolOfNode(item.entries['name']) ?? '';
    return n;
  }
  return '';
}

// ── Plans & logs ─────────────────────────────────────────────────────────────

function renderPlans(db: Db, ids: string[]): string | null {
  if (ids.length === 0) return null;
  const blocks: string[] = [];
  // Deterministic order by id.
  const sorted = [...ids].sort();
  for (const id of sorted) {
    let node: DeepNode;
    try { node = db.loadNodeDeep(id, 2); } catch { continue; }
    if (node.kind !== 'map') continue;
    const path = atomSymbol(node.entries['path']) ?? '';
    const content = atomMeaning(node.entries['content']) ?? '';
    const pathAttr = path ? ` path=${quote(path)}` : '';
    blocks.push(`<plan id="${id}"${pathAttr}>\n${content}\n</plan>`);
  }
  return blocks.length > 0 ? blocks.join('\n\n') : null;
}

function renderLogs(db: Db, ids: string[], shellLimit: number): string {
  const lines: string[] = [];
  for (const id of ids) {
    let node: DeepNode;
    try { node = db.loadNodeDeep(id, 1); } catch { continue; }
    if (node.kind !== 'map' || !node.typeName) continue;
    const t = node.typeName;
    if (t === 'FileOperation') continue;       // skipped per spec
    if (t === 'UserInput') {
      const text = atomSymbol(node.entries['text']) ?? '';
      lines.push(`User: ${text}`);
    } else if (t === 'AgentMessage') {
      const text = atomSymbol(node.entries['text']) ?? '';
      lines.push(`Agent: ${text}`);
    } else if (t === 'AgentQuestion') {
      const q = atomSymbol(node.entries['question']) ?? '';
      lines.push(`Agent: ${q}`);
    } else if (t === 'ShellExecution') {
      const cmd = atomSymbol(node.entries['command']) ?? '';
      const desc = atomSymbol(node.entries['description']) ?? '';
      const cropped = cropShellCommand(cmd, shellLimit);
      lines.push(desc ? `Shell: ${cropped}  # ${desc}` : `Shell: ${cropped}`);
    }
  }
  return `<logs>\n${lines.join('\n')}\n</logs>`;
}

// ── Atom / list helpers ──────────────────────────────────────────────────────

function atomSymbol(node: DeepNode | undefined): string | null {
  if (!node || node.kind !== 'atom') return null;
  if (node.atom.kind !== 'symbol') return null;
  return node.atom.value;
}

function atomSymbolOfNode(node: DeepNode | undefined): string | null {
  return atomSymbol(node);
}

function atomMeaning(node: DeepNode | undefined): string | null {
  if (!node || node.kind !== 'atom') return null;
  if (node.atom.kind !== 'meaning') return null;
  return node.atom.value.text;
}

function listOfRefs(node: DeepNode | undefined): string[] {
  if (!node || node.kind !== 'list') return [];
  const out: string[] = [];
  for (const item of node.items) {
    if (item.kind === 'ref') out.push(item.id);
    else if (item.kind === 'map' && item.id) out.push(item.id);
  }
  return out;
}

function parseMs(v: string | null): number | null {
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ── Diff & formatting ────────────────────────────────────────────────────────

function unifiedDiff(prev: string, cur: string, context: number): string {
  const patch = createTwoFilesPatch('a', 'b', prev, cur, '', '', { context });
  // Strip leading `Index:` / `===` / `---` / `+++` lines for readability.
  // Jsdiff's `createTwoFilesPatch` produces:
  //   ===================================================================
  //   --- a\n
  //   +++ b\n
  //   @@ ... @@\n
  //   <body>
  const lines = patch.split('\n');
  const start = lines.findIndex(l => l.startsWith('@@'));
  if (start < 0) return ''; // identical files
  return lines.slice(start).join('\n');
}

function renderCommentAttr(attrName: string, node: DeepNode & { kind: 'map' }): string {
  const c = atomMeaning(node.entries['comment']);
  if (!c) return '';
  return ` ${attrName}=${quote(c)}`;
}

function quote(s: string): string {
  // XML-style attribute quoting — escape `&`, `<`, `"`, and newlines.
  const escaped = s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/"/g, '&quot;')
    .replace(/\r/g, '')
    .replace(/\n/g, '&#10;');
  return `"${escaped}"`;
}

function cropShellCommand(cmd: string, limit: number): string {
  if (cmd.length <= limit) return cmd;
  const head = cmd.slice(0, limit);
  const dropped = cmd.length - limit;
  return `${head}… [truncated ${dropped} chars]`;
}
