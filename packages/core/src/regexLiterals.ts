/**
 * Conservative required-literal extraction for the FTS5-narrowed regex
 * search path. Walks a regex source string and emits maximal literal
 * substrings (length ≥ 3) that EVERY match must contain.
 *
 * Used by `Db.querySymbolRegex` to AND the literals as trigram phrase
 * queries against `nodes_fts`, shrinking the candidate set before JS
 * `RegExp.test(...)` runs.
 *
 * **Correctness invariant**: false negatives (missing an actually-required
 * literal) cost performance — we just scan more candidates. False
 * positives (claiming a literal is required when the pattern can match
 * without it) would silently DROP real matches. The rules below err
 * toward the safe side: when the pattern shape is hard to reason about
 * (groups, alternation, complex quantifiers), we give up and emit
 * fewer / zero literals.
 *
 * Rules:
 *   1. Walk char-by-char accumulating `current` literal run.
 *   2. Terminate the run on regex metachars (`. * + ? | ^ $ ( ) { } [ \`).
 *   3. `[…]` — terminate, skip to matching `]`.
 *   4. `(…)` — terminate, skip to matching `)` (nest-aware). v1 doesn't
 *      try to extract literals from alternation arms inside groups.
 *   5. `\<x>` — terminate; if `<x>` is an escaped metachar (`. * + ? | …`)
 *      append the literal `<x>` to a fresh run; else (`\d`, `\w`, `\s`,
 *      `\b`, `\n`, …) start fresh empty.
 *   6. On terminator, if the very next char is a "zero-allowing" quantifier
 *      (`?`, `*`, or `{0,…}`), drop the LAST char of the just-flushed run.
 *   7. Top-level `|` (depth 0) discards every collected run — no literal
 *      is universally required across both branches.
 *   8. Emit every run of length ≥ 3.
 */

/**
 * Quote a literal substring as a single FTS5 phrase. FTS5 phrases
 * double-quote-escape internal `"`; nothing else needs escaping because
 * the trigram tokenizer treats every char as content.
 */
export function ftsPhrase(s: string): string {
  return '"' + s.replace(/"/g, '""') + '"';
}

/** Metachars that terminate a literal run. */
const META = new Set([
  '.', '*', '+', '?', '|', '^', '$', '(', ')', '{', '}', '[', '\\',
]);

/** Escapes that re-introduce a literal char. */
const LITERAL_ESCAPES = new Set([
  '.', '*', '+', '?', '|', '^', '$', '(', ')', '{', '}', '[', ']', '/', '\\', '"', '#', '=', '!', ':', '-',
]);

/** Common single-char "actual character" escapes. */
const CHAR_ESCAPES: Record<string, string> = {
  n: '\n', t: '\t', r: '\r', f: '\f', v: '\v', 0: '\0',
};

export function extractRequiredLiterals(pattern: string): string[] {
  const runs: string[] = [];
  let current = '';
  let i = 0;

  const flush = (dropLast: boolean): void => {
    let s = current;
    current = '';
    if (dropLast) s = s.slice(0, -1);
    if (s.length >= 3) runs.push(s);
  };

  // `true` iff the very next non-skip step needs to consume a "drop the
  // last literal char" quantifier. We compute this lazily by peeking.
  const isZeroQuantAt = (idx: number): boolean => {
    const c = pattern[idx];
    if (c === '?' || c === '*') return true;
    if (c === '{') {
      // Parse `{m,n}` or `{m}`. Drop if m === 0.
      const close = pattern.indexOf('}', idx + 1);
      if (close === -1) return false;
      const body = pattern.slice(idx + 1, close);
      const m = body.match(/^(\d+)(?:,\d*)?$/);
      if (!m) return false;
      return m[1] === '0';
    }
    return false;
  };

  while (i < pattern.length) {
    const ch = pattern[i]!;

    if (ch === '\\') {
      // Escape sequence — handle the next char.
      const next = pattern[i + 1];
      i += 2;
      if (next == null) {
        // Dangling backslash; the regex would be invalid, but treat
        // defensively — flush + exit.
        flush(false);
        break;
      }
      if (LITERAL_ESCAPES.has(next)) {
        // Append as a literal char to the current run, then continue.
        // Apply the post-quantifier check to the appended char.
        current += next;
        if (isZeroQuantAt(i)) {
          flush(true);
          // Skip the quantifier glyph (1 char for ?/*, full {…} for braces).
          if (pattern[i] === '{') i = pattern.indexOf('}', i) + 1;
          else i += 1;
        }
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(CHAR_ESCAPES, next)) {
        current += CHAR_ESCAPES[next];
        if (isZeroQuantAt(i)) {
          flush(true);
          if (pattern[i] === '{') i = pattern.indexOf('}', i) + 1;
          else i += 1;
        }
        continue;
      }
      // Character class escape (\d, \w, \s, \b, …) or anything else —
      // not a literal char. Flush the current run.
      flush(false);
      continue;
    }

    if (ch === '[') {
      // Skip to matching ]. Honour `\]` inside the class.
      flush(false);
      i += 1;
      while (i < pattern.length && pattern[i] !== ']') {
        if (pattern[i] === '\\') i += 2;
        else i += 1;
      }
      i += 1; // step past ]
      // Quantifier on the class — drop last char of (already-empty) run; no-op.
      if (isZeroQuantAt(i)) {
        if (pattern[i] === '{') i = pattern.indexOf('}', i) + 1;
        else i += 1;
      }
      continue;
    }

    if (ch === '(') {
      // Skip the whole group; v1 doesn't recurse into alternation arms.
      flush(false);
      let depth = 1;
      i += 1;
      while (i < pattern.length && depth > 0) {
        const c = pattern[i]!;
        if (c === '\\') { i += 2; continue; }
        if (c === '(') depth += 1;
        else if (c === ')') depth -= 1;
        i += 1;
      }
      // Skip a trailing quantifier on the group.
      if (isZeroQuantAt(i)) {
        if (pattern[i] === '{') i = pattern.indexOf('}', i) + 1;
        else i += 1;
      }
      continue;
    }

    if (ch === '|') {
      // Top-level alternation — no literal is required across BOTH arms.
      return [];
    }

    if (ch === '^' || ch === '$') {
      // Anchors contribute no literal char.
      flush(false);
      i += 1;
      continue;
    }

    if (META.has(ch)) {
      // Any remaining metachar (., *, +, ?, {, }, etc. when not handled
      // above) — terminate the run. `.` `*` `+` `?` `{` mostly only appear
      // here as suffix to a preceding atom; for `.` (any-char) we just
      // terminate.
      flush(ch === '?' || ch === '*' || ch === '{');
      // If we consumed a {…} as quantifier, jump past it.
      if (ch === '{') {
        const close = pattern.indexOf('}', i);
        i = close === -1 ? pattern.length : close + 1;
      } else {
        i += 1;
      }
      continue;
    }

    // Literal char. Append, then check whether the NEXT position is a
    // zero-allowing quantifier — if so, this char is optional and we
    // drop it.
    current += ch;
    i += 1;
    if (isZeroQuantAt(i)) {
      flush(true);
      if (pattern[i] === '{') i = pattern.indexOf('}', i) + 1;
      else i += 1;
    }
  }
  flush(false);
  return runs;
}
