import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import { useUi } from '../state/store';
import { Card } from './Cards';
import { JsonView } from './JsonView';

type Tab = 'cards' | 'json';

export function NodeDetail() {
  const project = useUi(s => s.project);
  const id = useUi(s => s.selectedNodeId);
  const setSelected = useUi(s => s.setSelected);
  const [tab, setTab] = useState<Tab>('cards');

  const { data, error, isLoading } = useQuery({
    queryKey: ['node', project, id],
    queryFn: () => (project && id ? api.loadNode(project, id, 10) : Promise.resolve(null)),
    enabled: !!(project && id),
  });

  const refs = useQuery({
    queryKey: ['refs', project, id],
    queryFn: () => (project && id ? api.loadRefs(project, id) : Promise.resolve(null)),
    enabled: !!(project && id),
  });

  if (!id) return null;

  return (
    <div className="h-full flex flex-col min-h-0 bg-cream-50">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-cream-200 bg-cream-100">
        <div className="flex items-center gap-3 min-w-0">
          <button
            onClick={() => setSelected(null)}
            className="text-roast-medium hover:text-roast-dark text-sm flex items-center gap-1"
            title="Close (Esc)"
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
            back
          </button>
          <div className="h-4 w-px bg-cream-200" />
          <span className="text-[11px] uppercase tracking-widest text-roast-light">{data?.typeName ?? '—'}</span>
          <span className="font-mono text-xs text-roast-medium truncate">{id}</span>
        </div>
        <div className="flex items-center gap-1">
          <Tab active={tab === 'cards'} onClick={() => setTab('cards')}>Cards</Tab>
          <Tab active={tab === 'json'} onClick={() => setTab('json')}>JSON</Tab>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto min-h-0 px-6 py-4">
        {isLoading && <div className="text-roast-medium text-sm">loading…</div>}
        {error && <NotANodeBanner id={id} message={(error as Error).message} />}

        {data && (
          <div className="max-w-3xl mx-auto space-y-6">
            {tab === 'cards' ? (
              <Card value={data.node} />
            ) : (
              <JsonView value={data.node} />
            )}

            {refs.data && (refs.data.in.length > 0 || refs.data.out.length > 0) && (
              <div className="space-y-3">
                {refs.data.in.length > 0 && (
                  <RefsBlock title={`Referenced by (${refs.data.in.length})`} refs={refs.data.in} />
                )}
                {refs.data.out.length > 0 && (
                  <RefsBlock title={`References (${refs.data.out.length})`} refs={refs.data.out} />
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Tab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={
        'px-3 py-1 rounded text-xs ' +
        (active ? 'bg-roast-dark text-cream-50' : 'bg-cream-50 text-roast-medium hover:bg-cream-200')
      }
    >
      {children}
    </button>
  );
}

/**
 * Shown when `loadNode` 404s. The id we tried to open isn't a node in this
 * project — it's almost certainly a content UUID (e.g. an agent sessionId).
 * Offer a "find symbols matching this" jump so it stays useful.
 */
function NotANodeBanner({ id, message }: { id: string; message: string }) {
  const setSelected = useUi(s => s.setSelected);
  const setFilter = useUi(s => s.setFilter);
  const setTab = useUi(s => s.setTab);
  const setViewMode = useUi(s => s.setViewMode);

  const findReferences = () => {
    setSelected(null);
    setTab('graph');
    setViewMode('list');
    setFilter({ mode: 'exact', q: id, types: [], includeHidden: true });
  };

  return (
    <div className="max-w-2xl mx-auto bg-cream-100 border border-cream-200 rounded-lg p-5 space-y-3">
      <div className="text-[10px] uppercase tracking-widest text-status-warning">Not a node</div>
      <p className="text-roast-dark text-sm">
        <span className="font-mono text-xs bg-cream-200 px-1.5 py-0.5 rounded">{id}</span>
        {' '}is not a node id in this project. It's most likely an external UUID embedded as a
        symbol value (for example, a Claude Code <code>sessionId</code> or <code>messageId</code>).
      </p>
      <p className="text-roast-light text-xs">{message}</p>
      <div className="flex gap-2">
        <button
          onClick={findReferences}
          className="px-3 py-1.5 bg-roast-dark text-cream-50 rounded text-sm hover:bg-roast-medium"
        >
          Find nodes containing this UUID
        </button>
        <button
          onClick={() => setSelected(null)}
          className="px-3 py-1.5 bg-cream-200 text-roast-dark rounded text-sm hover:bg-cream-300"
        >
          Back
        </button>
      </div>
    </div>
  );
}

function RefsBlock({ title, refs }: { title: string; refs: { id: string; typeName: string }[] }) {
  const setSelected = useUi(s => s.setSelected);
  return (
    <div>
      <div className="text-[10px] uppercase tracking-widest text-roast-light mb-1.5">{title}</div>
      <div className="flex flex-wrap gap-1.5">
        {refs.map(r => (
          <button
            key={r.id}
            onClick={() => setSelected(r.id)}
            className="inline-flex items-center gap-1.5 bg-cream-100 hover:bg-cream-200 border border-cream-200 rounded px-2 py-1 text-xs transition"
          >
            <span className="text-roast-medium">{r.typeName}</span>
            <span className="font-mono text-roast-light">{r.id.slice(0, 6)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
