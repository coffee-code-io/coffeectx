import { create } from 'zustand';
import type { FilterMode } from '../api/client';

export type Tab = 'graph' | 'scheduler' | 'runs';
export type GraphViewMode = 'graph' | 'list';

interface UiState {
  project: string | null;
  tab: Tab;
  viewMode: GraphViewMode;
  selectedNodeId: string | null;
  filter: {
    mode: FilterMode;
    q: string;
    types: string[];
    depth: number;
    includeHidden: boolean;
  };
  setProject: (p: string | null) => void;
  setTab: (t: Tab) => void;
  setViewMode: (v: GraphViewMode) => void;
  setSelected: (id: string | null) => void;
  setFilter: (patch: Partial<UiState['filter']>) => void;
}

export const useUi = create<UiState>(set => ({
  project: null,
  tab: 'graph',
  viewMode: 'graph',
  selectedNodeId: null,
  filter: {
    mode: 'query',
    q: '',
    types: [],
    depth: 0,
    includeHidden: false,
  },
  setProject: p => set({ project: p, selectedNodeId: null }),
  setTab: t => set({ tab: t }),
  setViewMode: v => set({ viewMode: v }),
  setSelected: id => set({ selectedNodeId: id }),
  setFilter: patch => set(s => ({ filter: { ...s.filter, ...patch } })),
}));
