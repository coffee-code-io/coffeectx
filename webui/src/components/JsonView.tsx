/**
 * Minimal JSON syntax highlighter. Tokenizes a JSON.stringify(..., 2) string
 * with a regex pass and wraps each token in a span. No external dep.
 *
 * Token classes are CSS variables from the coffee palette so the highlighter
 * stays on-theme.
 */

import { useMemo } from 'react';

interface Props {
  value: unknown;
}

export function JsonView({ value }: Props) {
  const text = useMemo(() => JSON.stringify(value, null, 2), [value]);
  const tokens = useMemo(() => tokenize(text), [text]);

  return (
    <pre className="text-xs font-mono bg-cream-100 border border-cream-200 rounded-lg p-4 overflow-x-auto leading-relaxed">
      <code>
        {tokens.map((t, i) => (
          <span key={i} style={{ color: COLOR[t.cls] }}>
            {t.text}
          </span>
        ))}
      </code>
    </pre>
  );
}

type TokenClass = 'key' | 'string' | 'number' | 'boolean' | 'null' | 'punct' | 'plain';

const COLOR: Record<TokenClass, string> = {
  // Cooler-roast hues for syntactic categories — readable on cream-100.
  key:     '#3E2723', // roast-dark — headings of the object
  string:  '#556B2F', // olive — strings/meanings
  number:  '#8B4513', // saddle brown
  boolean: '#D2691E', // chocolate
  null:    '#C19A6B', // latte
  punct:   '#8D6E63', // roast-medium — braces, commas, colons
  plain:   '#3E2723',
};

interface Token {
  text: string;
  cls: TokenClass;
}

/**
 * Single regex pass over the pre-stringified text. We capture, in order:
 * - whitespace (preserved as 'plain')
 * - quoted strings  (then look-ahead for `:` to decide key vs value)
 * - numbers
 * - true/false/null literals
 * - structural punctuation
 */
const TOKEN_RE = /(\s+)|("(?:\\.|[^"\\])*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|(true|false|null)|([{}\[\],:])/g;

function tokenize(text: string): Token[] {
  const out: Token[] = [];
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(text)) !== null) {
    if (m.index > lastIndex) {
      out.push({ text: text.slice(lastIndex, m.index), cls: 'plain' });
    }
    const [whole, ws, str, colonAfter, num, lit, punct] = m;
    if (ws !== undefined) out.push({ text: whole, cls: 'plain' });
    else if (str !== undefined) {
      if (colonAfter !== undefined) {
        out.push({ text: str, cls: 'key' });
        out.push({ text: colonAfter, cls: 'punct' });
      } else {
        out.push({ text: str, cls: 'string' });
      }
    } else if (num !== undefined) out.push({ text: num, cls: 'number' });
    else if (lit !== undefined) out.push({ text: lit, cls: lit === 'null' ? 'null' : 'boolean' });
    else if (punct !== undefined) out.push({ text: punct, cls: 'punct' });
    lastIndex = TOKEN_RE.lastIndex;
  }
  if (lastIndex < text.length) {
    out.push({ text: text.slice(lastIndex), cls: 'plain' });
  }
  return out;
}
