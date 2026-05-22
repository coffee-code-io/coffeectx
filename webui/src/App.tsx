import { useEffect } from 'react';
import { ProjectSelector } from './components/ProjectSelector';
import { FilterRail } from './components/FilterRail';
import { GraphView } from './components/GraphView';
import { ListView } from './components/ListView';
import { NodeDetail } from './components/NodeDetail';
import { SchedulerView } from './components/SchedulerView';
import { RunsView } from './components/RunsView';
import { SchedulerDot } from './components/SchedulerDot';
import { AgentChatPanel } from './components/AgentChatPanel';
import { useUi, type Tab } from './state/store';

export function App() {
  const tab = useUi(s => s.tab);
  const setTab = useUi(s => s.setTab);
  const selected = useUi(s => s.selectedNodeId);
  const setSelected = useUi(s => s.setSelected);
  const viewMode = useUi(s => s.viewMode);

  // Esc closes detail overlay.
  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSelected(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, setSelected]);

  return (
    <div className="h-screen flex flex-col text-roast-dark bg-cream-50">
      {/* Top bar */}
      <header className="border-b border-cream-200 bg-cream-100 px-4 py-2 flex items-center gap-4">
        <span className="font-semibold tracking-tight text-roast-dark text-base">coffeectx</span>
        <ProjectSelector />
        <Tabs current={tab} onChange={setTab} />
        <div className="flex-1" />
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

function Tabs({ current, onChange }: { current: Tab; onChange: (t: Tab) => void }) {
  const items: { value: Tab; label: string }[] = [
    { value: 'graph', label: 'Graph' },
    { value: 'runs', label: 'Runs' },
    { value: 'scheduler', label: 'Scheduler' },
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
