/**
 * Span split/join heuristic weights.
 *
 * Tweak in one place to recompute spans without touching algorithm code.
 * All weights are unitless; larger values dominate. The cost at each
 * candidate boundary is `Σ split − Σ join`. Cut iff the cost exceeds
 * `CUT_THRESHOLD`; afterwards spans shorter than `MIN_SPAN_MESSAGES`
 * are merged into a neighbour.
 */

export const SPLIT_WEIGHTS = {
  /** Any UserInput at i+1 is a strong cut signal. */
  USER_MESSAGE: 10,
  /** ExitPlanMode at i → end of the planning span. */
  PLAN_ACCEPTED: 8,
  /** Gap between events larger than this contributes to the cut score. */
  LONG_INACTIVITY_GAP_MS: 5 * 60_000,
  /** Per-minute contribution beyond the threshold. */
  LONG_INACTIVITY_PER_MIN: 2,
  /** "done"/"implemented"/"fixed"/"shipped"/"merged"/"resolved" in an agent_message. */
  DONE_KEYWORD: 4,
  /** Terminal test-command: a test cmd at i with no test cmd at i+1. */
  TEST_CMD_TERMINAL: 3,
  /** TodoWrite where the final todo flipped to completed. */
  TODO_LIST_LAST_ITEM_COMPLETED: 3,
} as const;

export const JOIN_WEIGHTS = {
  /** Normalised word-Levenshtein < 0.3 between adjacent texts. */
  LEVENSHTEIN_NORM_BELOW_03: 5,
  /** Gap smaller than this contributes to the join score. */
  SHORT_GAP_MS: 30_000,
  SHORT_GAP_BONUS: 3,
  /** Both adjacent events are test commands. */
  CONSECUTIVE_TEST_CMD: 4,
  /** TodoWrite advanced but the last item is still pending/in_progress. */
  TODO_LIST_PARTIAL_PROGRESS: 2,
} as const;

export const SMALL_BATCH = {
  /** Spans shorter than this get merged into a neighbour. */
  MIN_SPAN_MESSAGES: 2,
  /** Penalty applied per missing message when scoring a small-span merge. */
  PENALTY_PER_MISSING_MESSAGE: 6,
} as const;

/** Boundary kept iff `score > CUT_THRESHOLD`. */
export const CUT_THRESHOLD = 0;

/**
 * A span whose last message is newer than `closeBeforeMs - HARD_BREAK_MS`
 * is treated as still in-progress and held back from emission. The next
 * crawl that runs after the hard break elapses with no further activity
 * closes the span. Anchors the user-facing invariant: a finalised Span
 * always has at least HARD_BREAK_MS of trailing inactivity.
 */
export const HARD_BREAK_MS = 5 * 60_000;

/** Done-keyword regex. Word-boundary; case-insensitive. */
export const DONE_KEYWORD_RE = /\b(done|implemented|fixed|shipped|merged|resolved)\b/i;

/** Narrower test-command regex than classifier's INTERESTING_BASH_RE — only
 *  test runners (not lint/build/typecheck). */
export const TEST_CMD_RE = /\b(pytest|jest|vitest|mocha|jasmine|karma|rspec|cargo\s+test|go\s+test|pnpm\s+test|npm\s+test|yarn\s+test)\b/i;

/** Identifier regex for word-Levenshtein extraction. 5+ chars to skip noise. */
export const IDENT_RE = /\b[A-Za-z_][A-Za-z0-9_]{4,}\b/g;
