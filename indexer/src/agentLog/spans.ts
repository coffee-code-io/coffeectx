/**
 * Segment a session's classified events into spans.
 *
 * Algorithm:
 *   1. Score every candidate boundary as `Σ split − Σ join` using the
 *      heuristic weights in spanHeuristics.ts.
 *   2. Cut at every boundary whose score exceeds `CUT_THRESHOLD`.
 *   3. Merge spans shorter than `SMALL_BATCH.MIN_SPAN_MESSAGES` into the
 *      neighbour with the weaker boundary.
 *   4. Label each span planning vs execution (planning iff the span ends
 *      at a `plan_accepted` event or contains one).
 *   5. Drop `plan_accepted` / `todo_write` events from the persisted
 *      message list — they're detection-only signals, not persisted.
 *   6. The last persisted message of every span is the span's `summary`;
 *      it carries `isSummary="true"` on its AgentMessage row.
 *
 * The caller (indexLogs.ts) is responsible for actually emitting Span
 * nodes — this module only produces the segmentation.
 */

import type { ClassifiedEvent } from './classifier.js';
import {
  SPLIT_WEIGHTS, JOIN_WEIGHTS, SMALL_BATCH, CUT_THRESHOLD,
  DONE_KEYWORD_RE, TEST_CMD_RE, IDENT_RE,
} from './spanHeuristics.js';

export interface ComputedSpan {
  /** Slice of the session's event list, in order. Excludes the
   *  detection-only kinds (`plan_accepted`, `todo_write`). */
  events: ClassifiedEvent[];
  kind: 'planning' | 'execution';
  startedAtMs: number;
  endedAtMs: number;
  /** Index of the event in `events` that should be marked isSummary=true. */
  summaryIndex: number;
}

/**
 * Compute spans for a single session.
 *
 * `events` is the full ordered list of classified events for the session,
 * including detection-only kinds (`plan_accepted`, `todo_write`). They feed
 * the boundary scorer but are stripped before emission.
 */
export function computeSpans(events: ClassifiedEvent[]): ComputedSpan[] {
  if (events.length === 0) return [];

  // ── Score boundaries ───────────────────────────────────────────────────────
  const scores: number[] = new Array(events.length - 1).fill(0);
  const identCache: Array<Set<string> | null> = new Array(events.length).fill(null);
  const eventText = (e: ClassifiedEvent): string =>
    e.text ?? e.question ?? e.command ?? e.path ?? '';
  const identsOf = (i: number): Set<string> => {
    let s = identCache[i];
    if (s) return s;
    s = new Set<string>();
    const text = eventText(events[i]!).toLowerCase();
    for (const [, w] of text.matchAll(IDENT_RE) as IterableIterator<RegExpMatchArray>) {
      if (w) s.add(w.toLowerCase());
    }
    identCache[i] = s;
    return s;
  };

  for (let i = 0; i < events.length - 1; i++) {
    const a = events[i]!;
    const b = events[i + 1]!;
    let score = 0;

    // ── Split signals ────────────────────────────────────────────────────────
    if (b.kind === 'user_input') score += SPLIT_WEIGHTS.USER_MESSAGE;
    if (a.kind === 'plan_accepted') score += SPLIT_WEIGHTS.PLAN_ACCEPTED;
    if (a.kind === 'agent_message' && a.text && DONE_KEYWORD_RE.test(a.text)) {
      score += SPLIT_WEIGHTS.DONE_KEYWORD;
    }
    if (a.kind === 'shell_exec' && TEST_CMD_RE.test(a.command ?? '') && !(b.kind === 'shell_exec' && TEST_CMD_RE.test(b.command ?? ''))) {
      score += SPLIT_WEIGHTS.TEST_CMD_TERMINAL;
    }
    if (a.kind === 'todo_write' && a.todos && a.todos.length > 0) {
      const last = a.todos[a.todos.length - 1]!;
      if (last.status === 'completed') score += SPLIT_WEIGHTS.TODO_LIST_LAST_ITEM_COMPLETED;
    }
    const gapMs = parseMs(b.timestamp) - parseMs(a.timestamp);
    if (gapMs > SPLIT_WEIGHTS.LONG_INACTIVITY_GAP_MS) {
      const extraMin = (gapMs - SPLIT_WEIGHTS.LONG_INACTIVITY_GAP_MS) / 60_000;
      score += SPLIT_WEIGHTS.LONG_INACTIVITY_PER_MIN * extraMin;
    }

    // ── Join signals ─────────────────────────────────────────────────────────
    const aIdents = identsOf(i);
    const bIdents = identsOf(i + 1);
    if (aIdents.size > 0 && bIdents.size > 0) {
      const norm = wordLevenshteinNormalised(aIdents, bIdents);
      if (norm < 0.3) score -= JOIN_WEIGHTS.LEVENSHTEIN_NORM_BELOW_03;
    }
    if (gapMs >= 0 && gapMs < JOIN_WEIGHTS.SHORT_GAP_MS) {
      score -= JOIN_WEIGHTS.SHORT_GAP_BONUS;
    }
    if (a.kind === 'shell_exec' && b.kind === 'shell_exec' &&
        TEST_CMD_RE.test(a.command ?? '') && TEST_CMD_RE.test(b.command ?? '')) {
      score -= JOIN_WEIGHTS.CONSECUTIVE_TEST_CMD;
    }
    if (a.kind === 'todo_write' && a.todos && a.todos.length > 0) {
      const last = a.todos[a.todos.length - 1]!;
      if (last.status !== 'completed') score -= JOIN_WEIGHTS.TODO_LIST_PARTIAL_PROGRESS;
    }

    scores[i] = score;
  }

  // ── Initial cuts ───────────────────────────────────────────────────────────
  /** Set of i where cut is kept (boundary between events[i] and events[i+1]). */
  const cuts = new Set<number>();
  for (let i = 0; i < scores.length; i++) {
    if (scores[i]! > CUT_THRESHOLD) cuts.add(i);
  }

  // ── Materialize spans ──────────────────────────────────────────────────────
  let segments = boundariesToSegments(events.length, cuts);

  // ── Small-batch merge ──────────────────────────────────────────────────────
  // Persisted length = events in the segment that aren't detection-only.
  segments = mergeSmallBatches(segments, events, scores);

  // ── Build ComputedSpan list ────────────────────────────────────────────────
  const out: ComputedSpan[] = [];
  for (const [start, end] of segments) {
    const slice = events.slice(start, end + 1);
    const persisted = slice.filter(isPersistable);
    if (persisted.length === 0) continue;

    const planning = slice.some(e => e.kind === 'plan_accepted');
    const kind: 'planning' | 'execution' = planning ? 'planning' : 'execution';

    // The terminal AgentMessage gets isSummary=true. If no AgentMessage in the
    // persisted slice, fall back to the last persisted event (the Span's
    // `summary` field accepts AgentMessage refs only; non-AgentMessage spans
    // skip the field and just point at messages).
    let summaryIndex = persisted.length - 1;
    for (let i = persisted.length - 1; i >= 0; i--) {
      if (persisted[i]!.kind === 'agent_message') {
        summaryIndex = i;
        break;
      }
    }

    const startedAtMs = parseMs(persisted[0]!.timestamp);
    const endedAtMs = parseMs(persisted[persisted.length - 1]!.timestamp);

    out.push({ events: persisted, kind, startedAtMs, endedAtMs, summaryIndex });
  }

  return out;
}

function isPersistable(e: ClassifiedEvent): boolean {
  return e.kind !== 'plan_accepted' && e.kind !== 'todo_write';
}

function boundariesToSegments(n: number, cuts: Set<number>): Array<[number, number]> {
  const segs: Array<[number, number]> = [];
  let start = 0;
  for (let i = 0; i < n - 1; i++) {
    if (cuts.has(i)) {
      segs.push([start, i]);
      start = i + 1;
    }
  }
  segs.push([start, n - 1]);
  return segs;
}

/** Persisted-length floor: any span below the floor merges into a neighbour. */
function mergeSmallBatches(
  segments: Array<[number, number]>,
  events: ClassifiedEvent[],
  scores: number[],
): Array<[number, number]> {
  const min = SMALL_BATCH.MIN_SPAN_MESSAGES;
  // Iteratively absorb small spans until all meet the floor or only one
  // remains.
  let changed = true;
  while (changed) {
    changed = false;
    for (let s = 0; s < segments.length; s++) {
      const [start, end] = segments[s]!;
      const persisted = countPersisted(events, start, end);
      if (persisted >= min) continue;
      if (segments.length === 1) break;
      // Merge into neighbour with the lower-magnitude boundary score
      // (the "weaker" boundary).
      const hasLeft = s > 0;
      const hasRight = s < segments.length - 1;
      const leftScore = hasLeft ? Math.abs(scores[start - 1] ?? 0) : Infinity;
      const rightScore = hasRight ? Math.abs(scores[end] ?? 0) : Infinity;
      if (!hasLeft || (hasRight && rightScore < leftScore)) {
        segments[s] = [start, segments[s + 1]![1]];
        segments.splice(s + 1, 1);
      } else {
        segments[s - 1] = [segments[s - 1]![0], end];
        segments.splice(s, 1);
      }
      changed = true;
      break;
    }
  }
  return segments;
}

function countPersisted(events: ClassifiedEvent[], start: number, end: number): number {
  let n = 0;
  for (let i = start; i <= end; i++) {
    if (isPersistable(events[i]!)) n += 1;
  }
  return n;
}

function parseMs(iso: string | undefined): number {
  if (!iso) return Date.now();
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? Date.now() : ms;
}

/** Token-level edit distance between two sets, normalised to [0..1].
 *  Treats sets as bags-of-tokens — order is irrelevant, only overlap. */
function wordLevenshteinNormalised(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  const union = a.size + b.size - inter;
  if (union === 0) return 0;
  return 1 - inter / union; // Jaccard distance — bounded in [0..1].
}
