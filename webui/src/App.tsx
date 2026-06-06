import { useEffect, useState, type MouseEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api/client';
import { decodeUrlState, installPopStateBridge, pushUrlState } from './state/urlState';
import { ProjectSelector } from './components/ProjectSelector';
import { FilterRail } from './components/FilterRail';
import { GraphView } from './components/GraphView';
import { ListView } from './components/ListView';
import { NodeDetail } from './components/NodeDetail';
import { SchedulerView } from './components/SchedulerView';
import { SkillsView } from './components/SkillsView';
import { SecretsView } from './components/SecretsView';
import { RunsView } from './components/RunsView';
import { SchedulerDot } from './components/SchedulerDot';
import { AgentChatPanel } from './components/AgentChatPanel';
import { useUi, type Tab } from './state/store';

export function App() {
  const tab = useUi(s => s.tab);
  const setTab = useUi(s => s.setTab);
  const selected = useUi(s => s.selectedNodeId);
  const setSelected = useUi(s => s.setSelected);
  const setDebug = useUi(s => s.setDebug);
  const viewMode = useUi(s => s.viewMode);

  // Bootstrap the global debug flag from the server. Stays in zustand
  // after this so every consumer reads it synchronously. `staleTime:
  // Infinity` because the only way the flag flips is editing config.yaml
  // — that's a server restart anyway.
  const debugQuery = useQuery({
    queryKey: ['debug'],
    queryFn: api.getDebug,
    staleTime: Infinity,
  });
  useEffect(() => {
    if (debugQuery.data) setDebug(debugQuery.data.debug);
  }, [debugQuery.data, setDebug]);

  // Esc closes detail overlay.
  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSelected(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, setSelected]);

  // One-shot URL ↔ store bridge bootstrap. On mount:
  //   1. If the URL has any nav params, hydrate the store from it (URL
  //      is canonical when present; deep links / shared links Just Work).
  //      Otherwise keep whatever zustand restored from localStorage.
  //   2. Install a `popstate` listener so browser back/forward applies
  //      the URL back onto the store.
  //   3. Subscribe to store changes so every navigation-shape mutation
  //      pushes a new history entry. `pushUrlState` short-circuits when
  //      the encoded URL is identical, so this stays cheap.
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    if ([...sp.keys()].length > 0) {
      const decoded = decodeUrlState(sp);
      const current = useUi.getState();
      useUi.setState({
        ...current,
        ...decoded,
        filter: { ...current.filter, ...(decoded.filter ?? {}) },
      });
    }
    installPopStateBridge(useUi);
    const unsub = useUi.subscribe(state => pushUrlState(state));
    return () => { unsub(); };
  }, []);

  return (
    <div className="h-screen flex flex-col text-roast-dark bg-cream-50">
      {/* Top bar */}
      <header className="border-b border-cream-200 bg-cream-100 px-4 py-2 flex items-center gap-4">
        <span className="font-semibold tracking-tight text-roast-dark text-base">coffeectx</span>
        <ProjectSelector />
        <Tabs current={tab} onChange={setTab} />
        <div className="flex-1" />
        <RefreshButton />
        <SchedulerDot />
      </header>

      {/* Body */}
      <div className="flex-1 grid grid-cols-[1fr_340px] min-h-0 overflow-hidden">
        {/* Main pane (graph / list / scheduler) — replaced wholesale when a node is selected */}
        <main className="min-h-0 overflow-hidden">
          {selected ? (
            <NodeDetail />
          ) : tab === 'graph' ? (
            <div className="h-full flex min-h-0">
              <FilterRail />
              <div className="flex-1 min-h-0">
                {viewMode === 'graph' ? <GraphView /> : <ListView />}
              </div>
            </div>
          ) : tab === 'runs' ? (
            <RunsView />
          ) : tab === 'skills' ? (
            <SkillsView />
          ) : tab === 'secrets' ? (
            <SecretsView />
          ) : (
            <SchedulerView />
          )}
        </main>

        {/* Right rail: agent (always visible, no jobs here anymore) */}
        <aside className="border-l border-cream-200 min-h-0 overflow-hidden">
          <AgentChatPanel />
        </aside>
      </div>
    </div>
  );
}

/**
 * Header refresh control. Drops the UI server's cached Db handle for the
 * current project (so the next API request opens a fresh SQLite
 * connection against the on-disk file — required after an external
 * `restore` / `reset` swap), then invalidates the React Query cache so
 * every mounted view refetches against the fresh handle. No page reload
 * — invalidation alone is enough now that the server side is correct,
 * and skipping the reload avoids the layout flash.
 */
function RefreshButton() {
  const qc = useQueryClient();
  const project = useUi(s => s.project);
  const [spinning, setSpinning] = useState(false);
  const handle = async (_e: MouseEvent) => {
    setSpinning(true);
    try {
      if (project) {
        try { await api.refreshProject(project); }
        catch { /* server may be down; still refresh client-side */ }
      }
      await qc.invalidateQueries();
    } finally {
      // Hold the spin long enough to read on a fast LAN.
      window.setTimeout(() => setSpinning(false), 600);
    }
  };
  return (
    <button
      onClick={handle}
      title="Refresh — drop server Db handle and refetch all queries"
      className="p-1.5 rounded text-roast-medium hover:text-roast-dark hover:bg-cream-200 transition"
    >
      <svg
        viewBox="0 0 24 24" width="16" height="16"
        fill="none" stroke="currentColor" strokeWidth="2"
        strokeLinecap="round" strokeLinejoin="round"
        className={spinning ? 'animate-spin' : ''}
      >
        <polyline points="23 4 23 10 17 10" />
        <polyline points="1 20 1 14 7 14" />
        <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
      </svg>
    </button>
  );
}

function Tabs({ current, onChange }: { current: Tab; onChange: (t: Tab) => void }) {
  const items: { value: Tab; label: string }[] = [
    { value: 'graph', label: 'Graph' },
    { value: 'runs', label: 'Runs' },
    { value: 'scheduler', label: 'Scheduler' },
    { value: 'skills', label: 'Skills' },
    { value: 'secrets', label: 'Secrets' },
  ];
  return (
    <nav className="flex bg-cream-50 border border-cream-200 rounded overflow-hidden">
      {items.map(it => (
        <button
          key={it.value}
          onClick={() => onChange(it.value)}
          className={
            'px-3 py-1 text-sm transition ' +
            (current === it.value
              ? 'bg-roast-dark text-cream-50'
              : 'text-roast-medium hover:bg-cream-200')
          }
        >
          {it.label}
        </button>
      ))}
    </nav>
  );
}
