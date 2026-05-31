import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { NodeDebugInfo, NodeDetailResponse } from '../api/client';
import { useUi } from '../state/store';
import { Card } from './Cards';
import { JsonView } from './JsonView';

// Named-type nodes mutate rarely from the UI's perspective. Bump the
// stale window so flipping tabs / drilling between nodes doesn't refetch.
const NODE_QUERY_OPTS = { staleTime: 5 * 60_000, gcTime: 60 * 60_000 };

type Tab = 'cards' | 'json';

export function NodeDetail() {
  const project = useUi(s => s.project);
  const id = useUi(s => s.selectedNodeId);
  const setSelected = useUi(s => s.setSelected);
  const [tab, setTab] = useState<Tab>('cards');

  // Cards tab uses depth=3 — anything deeper renders as a drill-in chip via
  // formatDeepNode's `{$id}` placeholders. Keeps DOM small on busy nodes.
  const debugOn = useUi(s => s.debug);

  const { data, error, isLoading } = useQuery({
    queryKey: ['node', project, id, 'cards'],
    queryFn: () => (project && id ? api.loadNode(project, id, 3) : Promise.resolve(null)),
    enabled: !!(project && id),
    ...NODE_QUERY_OPTS,
  });

  // JSON tab fetches a fuller tree, but only when the user actually clicks it.
  const jsonQuery = useQuery({
    queryKey: ['node', project, id, 'json'],
    queryFn: () => (project && id ? api.loadNode(project, id, 12) : Promise.resolve(null)),
    enabled: !!(project && id) && tab === 'json',
    ...NODE_QUERY_OPTS,
  });

  const refs = useQuery({
    queryKey: ['refs', project, id],
    queryFn: () => (project && id ? api.loadRefs(project, id) : Promise.resolve(null)),
    enabled: !!(project && id),
    ...NODE_QUERY_OPTS,
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
        <div className="flex items-center gap-3">
          {data && <VersionNav data={data} currentId={id} />}
          <div className="flex items-center gap-1">
            <Tab active={tab === 'cards'} onClick={() => setTab('cards')}>Cards</Tab>
            <Tab active={tab === 'json'} onClick={() => setTab('json')}>JSON</Tab>
          </div>
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
            ) : jsonQuery.isLoading ? (
              <div className="text-roast-medium text-sm">loading JSON…</div>
            ) : jsonQuery.data ? (
              <JsonView value={jsonQuery.data.node} />
            ) : (
              <JsonView value={data.node} />
            )}

            {debugOn && data.debug && <DebugSection info={data.debug} />}

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

/**
 * Header-right widget that surfaces the timeline a versioned node belongs
 * to, plus `←` / `→` arrows to step between versions. Renders nothing for
 * unversioned nodes (where `versions.length === 1`) so the chip never
 * shows for plain types like `Assumption` / `UserInput`.
 *
 * Clicking an arrow calls `setSelected(otherVersionId)`; the URL-state
 * subscription in `store.ts` + `urlState.ts` pushes a new history entry
 * automatically, so browser back/forward walks the version history.
 */
function VersionNav({
  data,
  currentId,
}: {
  data: NodeDetailResponse;
  currentId: string;
}) {
  const setSelected = useUi(s => s.setSelected);
  const versions = data.versions;
  if (!versions || versions.length <= 1) return null;

  const idx = versions.findIndex(v => v.id === currentId);
  if (idx === -1) return null;
  const current = versions[idx]!;
  const prev = idx > 0 ? versions[idx - 1] : null;
  const next = idx < versions.length - 1 ? versions[idx + 1] : null;

  // Read the timeline slug from `data.node` if formatDeepNode dropped a
  // `$timeline_id` key. Fall back to deriving from any version row's id
  // (every row in `versions` shares the same `timeline_id`, but the row
  // doesn't ship it — see TimelineVersionRow). For the short-prefix
  // display we just use the current row's timeline anchor via the node
  // payload.
  const timelineId = readTimelineId(data.node);

  return (
    <div className="flex items-center gap-1">
      <button
        onClick={() => prev && setSelected(prev.id)}
        disabled={!prev}
        title={prev ? `Go to v${prev.version}` : 'Already at oldest version'}
        className="px-1.5 py-0.5 text-roast-medium hover:text-roast-dark disabled:text-cream-300 disabled:cursor-not-allowed"
      >
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="15 18 9 12 15 6" />
        </svg>
      </button>
      <span
        title={timelineId ?? ''}
        className="select-none font-mono text-[11px] text-roast-medium bg-cream-50 border border-cream-200 rounded px-2 py-0.5"
      >
        v{current.version}
        {timelineId && (
          <>
            <span className="text-roast-light"> · </span>
            <span>{timelineId.slice(0, 8)}</span>
          </>
        )}
      </span>
      <button
        onClick={() => next && setSelected(next.id)}
        disabled={!next}
        title={next ? `Go to v${next.version}` : 'Already at latest version'}
        className="px-1.5 py-0.5 text-roast-medium hover:text-roast-dark disabled:text-cream-300 disabled:cursor-not-allowed"
      >
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="9 6 15 12 9 18" />
        </svg>
      </button>
      {current.tombstone && (
        <span
          title="This version is tombstoned — hidden from search."
          className="font-mono text-[10px] uppercase tracking-wider text-status-warning border border-dashed border-status-warning/60 rounded px-1.5 py-0.5"
        >
          deleted
        </span>
      )}
    </div>
  );
}

/** Pull `$timeline_id` out of a formatDeepNode object (top-level only —
 *  the timeline id of a deep tree's root). */
function readTimelineId(node: unknown): string | null {
  if (!node || typeof node !== 'object') return null;
  const v = (node as Record<string, unknown>)['$timeline_id'];
  return typeof v === 'string' ? v : null;
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

/**
 * Per-node debug instrumentation panel — appears only when the server's
 * `config.debug` flag is on AND the node has rows in `node_debug_info`.
 * Renders the `{field: value, ...}` blob written via `db.debugSet` via
 * the same syntax-highlighted JsonView the main JSON tab uses.
 */
function DebugSection({ info }: { info: NodeDebugInfo }) {
  return (
    <div className="border border-dashed border-status-warning/60 bg-status-warning/5 rounded-lg p-4 space-y-2">
      <div className="text-[10px] uppercase tracking-widest text-status-warning">
        Debug · <code className="font-mono">node_debug_info</code>
      </div>
      <JsonView value={info.debug} />
    </div>
  );
}

const REFS_INITIAL = 20;

function RefsBlock({ title, refs }: { title: string; refs: { id: string; typeName: string }[] }) {
  const setSelected = useUi(s => s.setSelected);
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? refs : refs.slice(0, REFS_INITIAL);
  const hidden = refs.length - visible.length;

  return (
    <div>
      <div className="text-[10px] uppercase tracking-widest text-roast-light mb-1.5">{title}</div>
      <div className="flex flex-wrap gap-1.5">
        {visible.map(r => (
          <button
            key={r.id}
            onClick={() => setSelected(r.id)}
            className="inline-flex items-center gap-1.5 bg-cream-100 hover:bg-cream-200 border border-cream-200 rounded px-2 py-1 text-xs transition"
          >
            <span className="text-roast-medium">{r.typeName}</span>
            <span className="font-mono text-roast-light">{r.id.slice(0, 6)}</span>
          </button>
        ))}
        {hidden > 0 && (
          <button
            onClick={() => setExpanded(true)}
            className="inline-flex items-center gap-1 bg-cream-50 border border-roast-medium/30 text-roast-medium hover:bg-cream-200 rounded px-2 py-1 text-xs transition"
          >
            Show all ({refs.length})
          </button>
        )}
      </div>
    </div>
  );
}
