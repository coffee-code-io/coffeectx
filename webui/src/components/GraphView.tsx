import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  type Node,
  type Edge,
  type NodeMouseHandler,
} from '@xyflow/react';
import {
  forceSimulation,
  forceManyBody,
  forceLink,
  forceCenter,
  forceCollide,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from 'd3-force';
import { api, type NodeSummary, type RefsBatchResponse, type RefsResponse } from '../api/client';
import { useUi } from '../state/store';
import { useFilteredNodes } from './hooks';
import { TruncationBanner } from './TruncationBanner';

const COLOR_BY_TYPE: Record<string, string> = {
  // Coffee-palette node colors per common type. Anything not listed gets the
  // default roast-medium below.
  Decision: '#C19A6B',
  Assumption: '#8D6E63',
  ChangeEvent: '#D2691E',
  File: '#556B2F',
  Folder: '#556B2F',
  AgentSession: '#C19A6B',
  UserInput: '#8D6E63',
  FileOperation: '#8D6E63',
  ShellExecution: '#8D6E63',
};

function typeColor(typeName: string | null | undefined): string {
  if (!typeName) return '#8D6E63';
  return COLOR_BY_TYPE[typeName] ?? '#8D6E63';
}

function nodeLabel(s: NodeSummary): string {
  const summary = s.summary as Record<string, unknown> | undefined;
  if (summary && typeof summary === 'object') {
    for (const key of ['title', 'name', 'path']) {
      const v = summary[key];
      if (typeof v === 'string' && v) return v.length > 36 ? v.slice(0, 33) + '…' : v;
    }
  }
  return s.id.slice(0, 8);
}

export function GraphView() {
  const project = useUi(s => s.project);
  const setSelected = useUi(s => s.setSelected);
  const selectedNodeId = useUi(s => s.selectedNodeId);

  const { matches, total, count, depthForced, limit, query } = useFilteredNodes();

  // Single batched fetch for every matched node's refs. Cache key is the
  // sorted id list so the same match set hits the cache regardless of ordering.
  const matchIds = useMemo(() => matches.map(m => m.id), [matches]);
  const sortedIdsKey = useMemo(() => [...matchIds].sort().join(','), [matchIds]);

  const refsBatch = useQuery({
    queryKey: ['refs-batch', project, sortedIdsKey],
    queryFn: () =>
      project && matchIds.length > 0
        ? api.loadRefsBatch(project, matchIds)
        : Promise.resolve({} as RefsBatchResponse),
    enabled: !!project && matchIds.length > 0,
  });

  const refMap = useMemo(() => {
    const m = new Map<string, RefsResponse>();
    if (refsBatch.data) {
      for (const [id, refs] of Object.entries(refsBatch.data)) m.set(id, refs);
    }
    return m;
  }, [refsBatch.data]);

  const { nodes, edges } = useGraph(matches, refMap, selectedNodeId);

  const onNodeClick: NodeMouseHandler = (_, n) => setSelected(n.id);

  if (!project) return <Placeholder>Pick a project to begin.</Placeholder>;
  if (query.isLoading) return <Placeholder>Searching…</Placeholder>;
  if (query.error) return <Placeholder error>{(query.error as Error).message}</Placeholder>;
  if (matches.length === 0) return <Placeholder>No matches. Adjust the filter on the left.</Placeholder>;

  return (
    <div className="h-full w-full flex flex-col">
      <TruncationBanner total={total} count={count} limit={limit} depthForced={depthForced} />
      <div className="flex-1 min-h-0">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodeClick={onNodeClick}
          fitView
          minZoom={0.1}
          maxZoom={2}
          proOptions={{ hideAttribution: true }}
          nodesDraggable
          nodesConnectable={false}
          edgesFocusable={false}
        >
          <Background color="#E3D5CA" gap={20} />
          <Controls />
          <MiniMap pannable zoomable maskColor="rgba(253,248,245,0.7)" />
        </ReactFlow>
      </div>
    </div>
  );
}

function useGraph(
  matches: NodeSummary[],
  refMap: Map<string, RefsResponse>,
  selectedId: string | null,
): { nodes: Node[]; edges: Edge[] } {
  const layoutKey = matches.map(m => m.id).join(',') +
    '|' + matches.map(m => (refMap.has(m.id) ? '1' : '0')).join('');

  const positions = useMemo<Record<string, { x: number; y: number }>>(() => {
    if (matches.length === 0) return {};
    const ids = new Set(matches.map(m => m.id));
    const simNodes: (SimulationNodeDatum & { id: string })[] = matches.map(m => ({ id: m.id }));
    const links: SimulationLinkDatum<SimulationNodeDatum & { id: string }>[] = [];
    for (const m of matches) {
      const refs = refMap.get(m.id);
      if (!refs) continue;
      for (const out of refs.out) {
        if (ids.has(out.id) && out.id !== m.id) {
          links.push({ source: m.id, target: out.id });
        }
      }
    }
    const sim = forceSimulation(simNodes)
      .force('charge', forceManyBody().strength(-220))
      .force(
        'link',
        forceLink<SimulationNodeDatum & { id: string }, SimulationLinkDatum<SimulationNodeDatum & { id: string }>>(links)
          .id(d => d.id)
          .distance(120)
          .strength(0.6),
      )
      .force('center', forceCenter(0, 0))
      .force('collide', forceCollide(50))
      .stop();
    for (let i = 0; i < 200; i++) sim.tick();
    const next: Record<string, { x: number; y: number }> = {};
    for (const n of simNodes) next[n.id] = { x: n.x ?? 0, y: n.y ?? 0 };
    return next;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutKey]);

  const nodes: Node[] = matches.map(m => {
    const pos = positions[m.id] ?? { x: 0, y: 0 };
    const color = typeColor(m.typeName);
    const isSelected = m.id === selectedId;
    const isNeighbor = !m.isMatch;
    return {
      id: m.id,
      position: pos,
      data: { label: nodeLabel(m) },
      style: {
        background: isNeighbor ? '#FDF8F5' : '#F5EBE0',
        color: '#3E2723',
        border: `2px ${isNeighbor ? 'dashed' : 'solid'} ${isSelected ? '#3E2723' : color}`,
        borderRadius: 8,
        padding: 6,
        fontSize: 11,
        fontFamily: 'Outfit, sans-serif',
        minWidth: 80,
        maxWidth: 160,
        opacity: isNeighbor ? 0.85 : 1,
      },
    };
  });

  const idSet = new Set(matches.map(m => m.id));
  const edges: Edge[] = [];
  for (const m of matches) {
    const refs = refMap.get(m.id);
    if (!refs) continue;
    for (const out of refs.out) {
      if (idSet.has(out.id) && out.id !== m.id) {
        edges.push({
          id: `${m.id}__${out.id}`,
          source: m.id,
          target: out.id,
          animated: false,
          style: { stroke: '#C19A6B' },
        });
      }
    }
  }
  return { nodes, edges };
}

function Placeholder({ children, error = false }: { children: React.ReactNode; error?: boolean }) {
  return (
    <div className={'h-full w-full flex items-center justify-center text-sm ' + (error ? 'text-status-error' : 'text-roast-medium')}>
      {children}
    </div>
  );
}
