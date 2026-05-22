import { useUi } from '../state/store';
import { useFilteredNodes } from './hooks';
import type { NodeSummary } from '../api/client';
import { TruncationBanner } from './TruncationBanner';

export function ListView() {
  const setSelected = useUi(s => s.setSelected);
  const project = useUi(s => s.project);
  const { matches, total, count, depthForced, limit, query, enabled } = useFilteredNodes();

  if (!project) return <Placeholder>Pick a project to begin.</Placeholder>;
  if (!enabled) return <Placeholder>Set a query or pick types on the left.</Placeholder>;
  if (query.isLoading) return <Placeholder>Searching…</Placeholder>;
  if (query.error) return <Placeholder error>{(query.error as Error).message}</Placeholder>;
  if (matches.length === 0) return <Placeholder>No matches.</Placeholder>;

  return (
    <div className="h-full flex flex-col">
      <TruncationBanner total={total} count={count} limit={limit} depthForced={depthForced} />
      <ul className="flex-1 overflow-y-auto p-4 space-y-2">
        {matches.map(m => (
          <ListItem key={m.id} item={m} onClick={() => setSelected(m.id)} />
        ))}
      </ul>
    </div>
  );
}

function ListItem({ item, onClick }: { item: NodeSummary; onClick: () => void }) {
  const summary = (item.summary ?? {}) as Record<string, unknown>;
  const title = pickTitle(summary) ?? item.id.slice(0, 8);
  const snippet = pickSnippet(summary, title);

  return (
    <li>
      <button
        onClick={onClick}
        className="w-full text-left bg-cream-100 hover:bg-cream-200 border border-cream-200 rounded-lg p-3 transition flex items-start gap-3"
      >
        <span
          className="mt-0.5 inline-block w-2 h-2 rounded-full shrink-0"
          style={{ background: item.isMatch ? '#3E2723' : '#C19A6B' }}
          title={item.isMatch ? 'direct match' : `neighbor (depth ${item.depth})`}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {item.typeName && (
              <span className="text-[10px] uppercase tracking-wider text-roast-light">
                {item.typeName}
              </span>
            )}
            {!item.isMatch && (
              <span className="text-[10px] text-roast-light">+{item.depth}</span>
            )}
            <span className="text-roast-dark font-medium truncate">{title}</span>
          </div>
          {snippet && (
            <div className="mt-1 text-sm text-roast-medium line-clamp-2">{snippet}</div>
          )}
          <div className="mt-1 font-mono text-[10px] text-roast-light">{item.id.slice(0, 8)}…</div>
        </div>
      </button>
    </li>
  );
}

function pickTitle(obj: Record<string, unknown>): string | null {
  for (const k of ['title', 'name', 'path']) {
    const v = obj[k];
    if (typeof v === 'string' && v) return v;
  }
  return null;
}

function pickSnippet(obj: Record<string, unknown>, title: string): string | null {
  for (const k of ['rationale', 'description', 'summary', 'text']) {
    const v = obj[k];
    if (typeof v === 'string' && v && v !== title) return v.replace(/\s+/g, ' ').slice(0, 200);
  }
  return null;
}

function Placeholder({ children, error = false }: { children: React.ReactNode; error?: boolean }) {
  return (
    <div className={'h-full w-full flex items-center justify-center text-sm ' + (error ? 'text-status-error' : 'text-roast-medium')}>
      {children}
    </div>
  );
}
