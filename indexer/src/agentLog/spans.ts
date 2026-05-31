/**
 * Segment a session's classified events into spans.
 *
 * Algorithm:
 *   1. Score every candidate boundary as `Σ split − Σ join` using the
 *      heuristic weights in spanHeuristics.ts. Each boundary records the
 *      named signals that fired so debug instrumentation can replay
 *      exactly why a cut happened (or didn't).
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
 * nodes — this module only produces the segmentation. Each returned
 * `ComputedSpan` carries the boundary scoring breakdown so callers can
 * stash it via `db.debugSet` for later inspection.
 */

import type { ClassifiedEvent } from './classifier.js';
import {
  SPLIT_WEIGHTS, JOIN_WEIGHTS, SMALL_BATCH, CUT_THRESHOLD, HARD_BREAK_MS,
  DONE_KEYWORD_RE, TEST_CMD_RE, IDENT_RE,
} from './spanHeuristics.js';

export interface BoundarySignal {
  /** Matches a key from `SPLIT_WEIGHTS` or `JOIN_WEIGHTS`. */
  name: string;
  /** Magnitude of the signal's contribution at this boundary. Always
   *  non-negative; `sign` carries the direction. */
  weight: number;
  /** `'+'` for split, `'-'` for join. */
  sign: '+' | '-';
}

export interface BoundaryScore {
  /** Index of the LEFT event in `events`; the boundary lives between
   *  events[i] and events[i+1]. */
  i: number;
  /** Unix-ms timestamp of event i+1 (the anchor). */
  atMs: number;
  /** Σ split − Σ join. Same value used by the cut threshold. */
  total: number;
  /** Per-signal contributions in firing order. */
  signals: BoundarySignal[];
}

export interface ComputedSpan {
  /** Slice of the session's event list, in order. Excludes the
   *  detection-only kinds (`plan_accepted`, `todo_write`). */
  events: ClassifiedEvent[];
  kind: 'planning' | 'execution';
  startedAtMs: number;
  endedAtMs: number;
  /** Index of the event in `events` that should be marked isSummary=true. */
  summaryIndex: number;
  /** Boundaries internal to this span (didn't cut). One entry per
   *  adjacent-event gap inside the segment. */
  boundaries: BoundaryScore[];
  /** Cut that opened this span (between the previous segment's last
   *  event and this span's first event). Absent for the first span of
   *  the session. */
  openingBoundary?: BoundaryScore;
  /** Cut that closed this span (between this span's last event and the
   *  next segment's first event). Absent if the span runs to session
   *  end (then the hard-break gate finalised it, not a cut). */
  closingBoundary?: BoundaryScore;
}

/**
 * Compute spans for a single session.
 *
 * `events` is the full ordered list of classified events for the session,
 * including detection-only kinds (`plan_accepted`, `todo_write`). They feed
 * the boundary scorer but are stripped before emission.
 *
 * `closeBeforeMs` (default `Date.now()`) is the upper bound for a span's
 * `endedAt` to qualify as finalised. Any computed span whose final event
 * happened within `HARD_BREAK_MS` of `closeBeforeMs` is treated as still
 * in-progress and omitted — its events stay un-attributed (state
 * `unspanned` upstream) until the hard break elapses. Only the trailing
 * span of the session is at risk; interior spans by construction have a
 * later span after them and are always finalised.
 */
export function computeSpans(
  events: ClassifiedEvent[],
  closeBeforeMs: number = Date.now(),
): ComputedSpan[] {
  if (events.length === 0) return [];

  // ── Score boundaries ───────────────────────────────────────────────────────
  const boundaries: BoundaryScore[] = new Array(events.length - 1);
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
    const signals: BoundarySignal[] = [];
    const split = (name: keyof typeof SPLIT_WEIGHTS, weight: number) =>
      signals.push({ name, weight, sign: '+' });
    const join = (name: keyof typeof JOIN_WEIGHTS, weight: number) =>
      signals.push({ name, weight, sign: '-' });

    // ── Split signals ────────────────────────────────────────────────────────
    if (b.kind === 'user_input') split('USER_MESSAGE', SPLIT_WEIGHTS.USER_MESSAGE);
    if (a.kind === 'plan_accepted') split('PLAN_ACCEPTED', SPLIT_WEIGHTS.PLAN_ACCEPTED);
    if (a.kind === 'agent_message' && a.text && DONE_KEYWORD_RE.test(a.text)) {
      split('DONE_KEYWORD', SPLIT_WEIGHTS.DONE_KEYWORD);
    }
    if (a.kind === 'shell_exec' && TEST_CMD_RE.test(a.command ?? '') && !(b.kind === 'shell_exec' && TEST_CMD_RE.test(b.command ?? ''))) {
      split('TEST_CMD_TERMINAL', SPLIT_WEIGHTS.TEST_CMD_TERMINAL);
    }
    if (a.kind === 'todo_write' && a.todos && a.todos.length > 0) {
      const last = a.todos[a.todos.length - 1]!;
      if (last.status === 'completed') split('TODO_LIST_LAST_ITEM_COMPLETED', SPLIT_WEIGHTS.TODO_LIST_LAST_ITEM_COMPLETED);
    }
    const gapMs = parseMs(b.timestamp) - parseMs(a.timestamp);
    if (gapMs > SPLIT_WEIGHTS.LONG_INACTIVITY_GAP_MS) {
      const extraMin = (gapMs - SPLIT_WEIGHTS.LONG_INACTIVITY_GAP_MS) / 60_000;
      split('LONG_INACTIVITY_PER_MIN', SPLIT_WEIGHTS.LONG_INACTIVITY_PER_MIN * extraMin);
    }

    // ── Join signals ─────────────────────────────────────────────────────────
    const aIdents = identsOf(i);
    const bIdents = identsOf(i + 1);
    if (aIdents.size > 0 && bIdents.size > 0) {
      const norm = wordLevenshteinNormalised(aIdents, bIdents);
      if (norm < 0.3) join('LEVENSHTEIN_NORM_BELOW_03', JOIN_WEIGHTS.LEVENSHTEIN_NORM_BELOW_03);
    }
    if (gapMs >= 0 && gapMs < JOIN_WEIGHTS.SHORT_GAP_MS) {
      join('SHORT_GAP_BONUS', JOIN_WEIGHTS.SHORT_GAP_BONUS);
    }
    if (a.kind === 'shell_exec' && b.kind === 'shell_exec' &&
        TEST_CMD_RE.test(a.command ?? '') && TEST_CMD_RE.test(b.command ?? '')) {
      join('CONSECUTIVE_TEST_CMD', JOIN_WEIGHTS.CONSECUTIVE_TEST_CMD);
    }
    if (a.kind === 'todo_write' && a.todos && a.todos.length > 0) {
      const last = a.todos[a.todos.length - 1]!;
      if (last.status !== 'completed') join('TODO_LIST_PARTIAL_PROGRESS', JOIN_WEIGHTS.TODO_LIST_PARTIAL_PROGRESS);
    }

    let total = 0;
    for (const s of signals) total += s.sign === '+' ? s.weight : -s.weight;
    boundaries[i] = { i, atMs: parseMs(b.timestamp), total, signals };
  }

  const scores = boundaries.map(b => b.total);

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
  for (let segIdx = 0; segIdx < segments.length; segIdx++) {
    const [start, end] = segments[segIdx]!;
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

    // Hard-break gate: a span isn't finalised until HARD_BREAK_MS of
    // inactivity follows its last event. The trailing span of a still-warm
    // session fails this check and is held back until a future crawl.
    if (endedAtMs > closeBeforeMs - HARD_BREAK_MS) continue;

    // Internal boundaries: every gap inside [start, end - 1].
    const internal: BoundaryScore[] = [];
    for (let i = start; i < end; i++) internal.push(boundaries[i]!);

    // Opening cut: the boundary at (start - 1) — between previous
    // segment's tail and this segment's head. Undefined for segIdx===0.
    const openingBoundary = segIdx > 0 ? boundaries[start - 1] : undefined;
    // Closing cut: the boundary at end — between this segment's tail
    // and next segment's head. Undefined for the last segment.
    const closingBoundary = segIdx < segments.length - 1 ? boundaries[end] : undefined;

    out.push({
      events: persisted, kind, startedAtMs, endedAtMs, summaryIndex,
      boundaries: internal,
      openingBoundary,
      closingBoundary,
    });
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
