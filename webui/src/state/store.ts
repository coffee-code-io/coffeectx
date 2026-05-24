import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
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
  /**
   * Remember which agent session was last active per project so a page
   * reload doesn't kick the user back to the most-recent session. The
   * AgentChatPanel uses this on mount to re-activate the right JSONL.
   * Server falls back to `continueRecent` if the stored path no longer
   * exists.
   */
  activeAgentSessionByProject: Record<string, string>;
  setProject: (p: string | null) => void;
  setTab: (t: Tab) => void;
  setViewMode: (v: GraphViewMode) => void;
  setSelected: (id: string | null) => void;
  setFilter: (patch: Partial<UiState['filter']>) => void;
  rememberAgentSession: (project: string, sessionPath: string | undefined) => void;
}

export const useUi = create<UiState>()(
  persist(
    (set) => ({
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
      activeAgentSessionByProject: {},
      setProject: p => set({ project: p, selectedNodeId: null }),
      setTab: t => set({ tab: t }),
      setViewMode: v => set({ viewMode: v }),
      setSelected: id => set({ selectedNodeId: id }),
      setFilter: patch => set(s => ({ filter: { ...s.filter, ...patch } })),
      rememberAgentSession: (project, sessionPath) => set(s => {
        const next = { ...s.activeAgentSessionByProject };
        if (sessionPath) next[project] = sessionPath; else delete next[project];
        return { activeAgentSessionByProject: next };
      }),
    }),
    {
      name: 'coffeectx.ui.v1',
      storage: createJSONStorage(() => localStorage),
      // Persist everything BUT the transient draft fields would be wrong
      // to round-trip. We don't have any here — selectedNodeId is fine to
      // restore (the detail pane re-opens for the last-viewed node).
      partialize: (s) => ({
        project: s.project,
        tab: s.tab,
        viewMode: s.viewMode,
        selectedNodeId: s.selectedNodeId,
        filter: s.filter,
        activeAgentSessionByProject: s.activeAgentSessionByProject,
      }),
    },
  ),
);
