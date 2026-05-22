import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type FilterMode } from '../api/client';
import { useUi } from '../state/store';

interface ModeDef {
  value: FilterMode;
  label: string;
  tooltip: string;
  icon: React.ReactNode;
}

const MODES: ModeDef[] = [
  {
    value: 'query',
    label: 'Query',
    tooltip: 'Query language — e.g. IsType "Decision", Meaning "auth flow"',
    icon: <BracesIcon />,
  },
  {
    value: 'exact',
    label: 'Exact',
    tooltip: 'Exact symbol match',
    icon: <EqualsIcon />,
  },
  {
    value: 'regex',
    label: 'Regex',
    tooltip: 'Regex on symbols and meanings (case-insensitive)',
    icon: <RegexIcon />,
  },
  {
    value: 'search',
    label: 'Symbolic',
    tooltip: 'Semantic vector search',
    icon: <WaveIcon />,
  },
];

export function FilterRail() {
  const project = useUi(s => s.project);
  const filter = useUi(s => s.filter);
  const setFilter = useUi(s => s.setFilter);
  const viewMode = useUi(s => s.viewMode);
  const setViewMode = useUi(s => s.setViewMode);
  const [draftQ, setDraftQ] = useState(filter.q);

  useEffect(() => { setDraftQ(filter.q); }, [filter.q]);

  const { data: types } = useQuery({
    queryKey: ['types', project],
    queryFn: () => (project ? api.listTypes(project) : Promise.resolve([])),
    enabled: !!project,
  });

  const submit = (e?: React.FormEvent) => {
    e?.preventDefault();
    setFilter({ q: draftQ });
  };

  const visibleTypes = (types ?? []).filter(t => filter.includeHidden || !t.hidden);

  return (
    <aside className="w-72 shrink-0 bg-cream-100 border-r border-cream-200 p-3 flex flex-col gap-4 overflow-y-auto">
      {/* View toggle */}
      <div>
        <Label>View</Label>
        <div className="flex bg-cream-50 border border-cream-200 rounded overflow-hidden">
          <ViewToggleBtn active={viewMode === 'graph'} onClick={() => setViewMode('graph')}>
            <GraphIcon /> Graph
          </ViewToggleBtn>
          <ViewToggleBtn active={viewMode === 'list'} onClick={() => setViewMode('list')}>
            <ListIcon /> List
          </ViewToggleBtn>
        </div>
      </div>

      {/* Mode picker */}
      <div>
        <Label>Search</Label>
        <div className="flex bg-cream-50 border border-cream-200 rounded overflow-hidden">
          {MODES.map(m => (
            <button
              key={m.value}
              type="button"
              onClick={() => setFilter({ mode: m.value })}
              title={m.tooltip}
              aria-label={m.label}
              className={
                'flex-1 flex items-center justify-center py-1.5 transition ' +
                (filter.mode === m.value
                  ? 'bg-roast-dark text-cream-50'
                  : 'text-roast-medium hover:bg-cream-200')
              }
            >
              {m.icon}
            </button>
          ))}
        </div>

        <form onSubmit={submit} className="mt-2 flex gap-1">
          <input
            type="text"
            value={draftQ}
            onChange={e => setDraftQ(e.target.value)}
            placeholder={MODES.find(m => m.value === filter.mode)?.label ?? ''}
            className="flex-1 bg-cream-50 border border-cream-200 rounded px-2 py-1 text-sm text-roast-dark placeholder:text-roast-light focus:outline-none focus:ring-2 focus:ring-roast-light"
          />
          <button
            type="submit"
            className="px-2 py-1 bg-roast-dark text-cream-50 rounded hover:bg-roast-medium"
            title="Apply (Enter)"
          >
            <ArrowRightIcon />
          </button>
        </form>
      </div>

      {/* Types — multi-select via click-to-toggle checkbox list */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <Label>Types{filter.types.length > 0 ? ` · ${filter.types.length}` : ''}</Label>
          {filter.types.length > 0 && (
            <button
              type="button"
              onClick={() => setFilter({ types: [] })}
              className="text-[11px] text-roast-medium hover:text-roast-dark"
              title="Clear all selected types"
            >
              clear
            </button>
          )}
        </div>
        <ul className="max-h-56 overflow-y-auto bg-cream-50 border border-cream-200 rounded divide-y divide-cream-200">
          {visibleTypes.length === 0 && (
            <li className="px-2 py-1.5 text-xs text-roast-light">no types loaded</li>
          )}
          {visibleTypes.map(t => {
            const checked = filter.types.includes(t.name);
            const toggle = () =>
              setFilter({
                types: checked
                  ? filter.types.filter(x => x !== t.name)
                  : [...filter.types, t.name],
              });
            return (
              <li key={t.name}>
                <button
                  type="button"
                  onClick={toggle}
                  className={
                    'w-full flex items-center gap-2 px-2 py-1.5 text-left text-sm transition ' +
                    (checked
                      ? 'bg-roast-dark/5 text-roast-dark'
                      : 'text-roast-medium hover:bg-cream-200')
                  }
                >
                  <CheckBox checked={checked} />
                  <span className="truncate">{t.name}</span>
                  {t.hidden && (
                    <span className="ml-auto text-[10px] text-roast-light uppercase tracking-wider">hidden</span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      {/* Depth */}
      <div>
        <Label>Depth (neighbors): <span className="text-roast-dark">{filter.depth}</span></Label>
        <input
          type="range"
          min={0}
          max={3}
          step={1}
          value={filter.depth}
          onChange={e => setFilter({ depth: parseInt(e.target.value, 10) })}
          className="w-full accent-roast-dark"
        />
        <div className="flex justify-between text-[10px] text-roast-light">
          <span>0</span><span>1</span><span>2</span><span>3</span>
        </div>
      </div>

      {/* Show hidden */}
      <label className="flex items-center gap-2 text-sm text-roast-medium select-none cursor-pointer">
        <input
          type="checkbox"
          checked={filter.includeHidden}
          onChange={e => setFilter({ includeHidden: e.target.checked })}
          className="accent-roast-dark"
        />
        show hidden types
      </label>
    </aside>
  );
}

// ── Small visual helpers ────────────────────────────────────────────────────

function Label({ children }: { children: React.ReactNode }) {
  return <div className="text-[11px] uppercase tracking-wider text-roast-light mb-1">{children}</div>;
}

function CheckBox({ checked }: { checked: boolean }) {
  return (
    <span
      className={
        'inline-flex items-center justify-center w-4 h-4 shrink-0 rounded border ' +
        (checked
          ? 'bg-roast-dark border-roast-dark text-cream-50'
          : 'bg-cream-50 border-cream-300')
      }
    >
      {checked && (
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      )}
    </span>
  );
}

function ViewToggleBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'flex-1 flex items-center justify-center gap-1.5 py-1.5 text-sm ' +
        (active ? 'bg-roast-dark text-cream-50' : 'text-roast-medium hover:bg-cream-200')
      }
    >
      {children}
    </button>
  );
}

// ── Inline SVG icons (no external deps) ─────────────────────────────────────

function BracesIcon()      { return <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M8 4H6a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2 2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h2"/><path d="M16 4h2a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2 2 2 0 0 0-2 2v4a2 2 0 0 1-2 2h-2"/></svg>; }
function EqualsIcon()      { return <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="5" y1="9" x2="19" y2="9"/><line x1="5" y1="15" x2="19" y2="15"/></svg>; }
function RegexIcon()       { return <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M16 4v10M11 7l10 3M11 11l10-3"/><circle cx="6" cy="17" r="2" fill="currentColor" stroke="none"/></svg>; }
function WaveIcon()        { return <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12c1.5-3 3-3 4.5 0s3 3 4.5 0 3-3 4.5 0 3 3 4.5 0"/></svg>; }
function ArrowRightIcon()  { return <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>; }
function GraphIcon()       { return <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="12" cy="18" r="2.5"/><path d="M8 7l8 0M7.5 8l3 8M16.5 8l-3 8"/></svg>; }
function ListIcon()        { return <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><line x1="8" y1="6" x2="20" y2="6"/><line x1="8" y1="12" x2="20" y2="12"/><line x1="8" y1="18" x2="20" y2="18"/><circle cx="4" cy="6" r="1" fill="currentColor"/><circle cx="4" cy="12" r="1" fill="currentColor"/><circle cx="4" cy="18" r="1" fill="currentColor"/></svg>; }
