/**
 * Recursive renderer for the JSON shape that `formatDeepNode` produces.
 *
 *   - object with $type     → nested card (drilled into) OR ref chip when over budget
 *   - object with $id only  → clickable ref chip (truncated subtree from depth-limited fetch)
 *   - plain object          → rows
 *   - array                 → numbered list
 *   - string matching UUID  → clickable ref chip
 *   - markdown-like string  → rendered via react-markdown
 *   - short string          → plain text
 *
 * Performance budget:
 *  - At most CARD_BFS_CAP (30) named-type cards are rendered per Card<root>.
 *  - Named-type cards beyond CARD_DEPTH_CAP (2) hops from the root render as
 *    drill-in chips, regardless of remaining cap.
 *  - Plain-map / list / atom rendering is uncapped — only named-type expansion
 *    consumes the budget.
 */

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useUi } from '../state/store';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CARD_BFS_CAP = 30;
const CARD_DEPTH_CAP = 2;

interface CardBudget {
  /** How many named-type cards have already been rendered in this Card tree. */
  rendered: number;
}

interface Props {
  value: unknown;
  depth?: number;
}

export function Card({ value, depth = 0 }: Props) {
  // Single mutable budget object shared across the recursion.
  const budget: CardBudget = { rendered: 0 };
  return <ValueView value={value} depth={depth} budget={budget} />;
}

interface ValueProps {
  value: unknown;
  depth: number;
  budget: CardBudget;
}

function ValueView({ value, depth, budget }: ValueProps) {
  if (value == null) return <span className="text-roast-light italic">∅</span>;

  if (typeof value === 'string') return <StringView text={value} />;

  if (typeof value === 'number' || typeof value === 'boolean') {
    return <span className="font-mono text-roast-dark">{String(value)}</span>;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-roast-light italic">[]</span>;
    return (
      <ol className="list-decimal list-inside space-y-1 marker:text-roast-light">
        {value.map((item, i) => (
          <li key={i} className="text-roast-dark">
            <ValueView value={item} depth={depth} budget={budget} />
          </li>
        ))}
      </ol>
    );
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const hasType = typeof obj.$type === 'string';
    const hasId = typeof obj.$id === 'string';

    if (hasType) {
      const overDepth = depth >= CARD_DEPTH_CAP;
      const overBudget = budget.rendered >= CARD_BFS_CAP;
      // Demote to a drill-in chip if we're past depth or out of budget AND
      // we have a $id to chip on. Otherwise expand inline.
      if ((overDepth || overBudget) && hasId) {
        return <RefChip id={obj.$id as string} kind="node" typeName={obj.$type as string} />;
      }
      budget.rendered += 1;
      return <TypedCard obj={obj} depth={depth} budget={budget} />;
    }

    if (hasId) return <RefChip id={obj.$id as string} kind="node" />;
    return <ObjectRows obj={obj} depth={depth} budget={budget} />;
  }

  return <span>{String(value)}</span>;
}

function TypedCard({ obj, depth, budget }: { obj: Record<string, unknown>; depth: number; budget: CardBudget }) {
  // Strip the metadata keys so they don't render as data rows.
  const { $type, $id: _id, $state, ...rest } = obj;
  void _id;
  return (
    <div className="bg-cream-100 border border-cream-200 rounded-lg p-3 space-y-2 animate-fade-up">
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-[10px] uppercase tracking-widest text-roast-light">{String($type)}</div>
        {typeof $state === 'string' && (
          <div className="text-[10px] font-mono text-roast-light">
            state:{' '}
            <span className="text-roast-medium">{$state}</span>
          </div>
        )}
      </div>
      <ObjectRows obj={rest} depth={depth + 1} budget={budget} />
    </div>
  );
}

function ObjectRows({ obj, depth, budget }: { obj: Record<string, unknown>; depth: number; budget: CardBudget }) {
  const keys = Object.keys(obj);
  if (keys.length === 0) return <span className="text-roast-light italic">{}</span>;
  return (
    <div className="space-y-2">
      {keys.map(k => (
        <div key={k} className="flex flex-col gap-1">
          <div className="text-[11px] text-roast-light font-mono">{k}</div>
          <div className="pl-2 border-l-2 border-cream-200">
            <ValueView value={obj[k]} depth={depth} budget={budget} />
          </div>
        </div>
      ))}
    </div>
  );
}

function RefChip({ id, kind, typeName }: { id: string; kind: 'node' | 'uuid'; typeName?: string }) {
  const setSelected = useUi(s => s.setSelected);
  const isNode = kind === 'node';
  return (
    <button
      onClick={() => setSelected(id)}
      className={
        'inline-flex items-center gap-1 border rounded px-1.5 py-0.5 text-xs font-mono transition ' +
        (isNode
          ? 'bg-cream-200 hover:bg-cream-300 border-cream-300 text-roast-dark'
          : 'bg-cream-50 hover:bg-cream-200 border-dashed border-cream-300 text-roast-medium')
      }
      title={isNode ? id : `${id} — may be an external UUID; click to inspect`}
    >
      {isNode ? '→' : '⋯'} {typeName ? <span className="text-roast-light">{typeName}</span> : null}{' '}
      {id.slice(0, 8)}
    </button>
  );
}

function StringView({ text }: { text: string }) {
  if (UUID_RE.test(text.trim())) {
    return <RefChip id={text.trim()} kind="uuid" />;
  }
  const long = text.length > 80 || /[\n#*`>_\[\]]/.test(text);
  if (!long) {
    return <span className="text-roast-dark whitespace-pre-wrap break-words">{text}</span>;
  }
  return (
    <div className="prose prose-sm max-w-none prose-p:my-1 prose-li:my-0 prose-headings:text-roast-dark prose-p:text-roast-dark prose-strong:text-roast-dark prose-li:text-roast-dark prose-code:text-roast-dark prose-code:bg-cream-200 prose-code:px-1 prose-code:rounded">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}
