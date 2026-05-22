/** Typed fetch wrapper for the coffeectx UI server. */

export interface ProjectInfo {
  name: string;
  enabled: boolean;
  repoPath: string | null;
  hasDb: boolean;
  isActive: boolean;
}

export interface NamedTypeInfo {
  name: string;
  description: string | null;
  source: string;
  hidden: boolean;
}

export interface NodeSummary {
  id: string;
  typeName: string | null;
  matchedId: string;
  summary: unknown;
  /** 0 = original match; >0 = N-hop neighbor. */
  depth: number;
  isMatch: boolean;
}

export interface NodesResponse {
  total: number;
  count: number;
  offset: number;
  results: NodeSummary[];
}

export interface NodeDetailResponse {
  id: string;
  typeName: string | null;
  node: unknown;
  raw: unknown;
}

export interface NodeRef {
  id: string;
  typeName: string;
}

export interface RefsResponse {
  in: NodeRef[];
  out: NodeRef[];
}

export interface JobRow {
  name: string;
  description: string | null;
  enabled: boolean;
  status: 'idle' | 'running' | 'disabled';
  currentRunId: number | null;
  lastStartedAt: string | null;
  lastEndedAt: string | null;
  lastResult: 'ok' | 'error' | 'cancelled' | null;
  lastError: string | null;
  lastMessage: string | null;
  lastMetrics: Record<string, number> | null;
  triggerPending: boolean;
  state: unknown | null;
}

export interface SchedulerStatus {
  alive: boolean;
  lastSeenAt: string | null;
  pid: number | null;
}

/** "Symbolic" in the UI maps to mode=search server-side (semantic vector search). */
export type FilterMode = 'query' | 'exact' | 'regex' | 'search';

async function http<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, init);
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try { const body = await res.json(); if (body?.error) msg = body.error; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

export const api = {
  listProjects: () => http<ProjectInfo[]>('/api/projects'),
  setProjectEnabled: (name: string, enabled: boolean) =>
    http<{ name: string; enabled: boolean }>(`/api/projects/${encodeURIComponent(name)}/enabled`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    }),

  listTypes: (project: string) =>
    http<NamedTypeInfo[]>(`/api/p/${encodeURIComponent(project)}/types`),

  searchNodes: (
    project: string,
    params: {
      mode: FilterMode;
      q?: string;
      types?: string[];
      depth?: number;
      limit?: number;
      offset?: number;
      includeHidden?: boolean;
    },
  ) => {
    const qs = new URLSearchParams();
    qs.set('mode', params.mode);
    if (params.q !== undefined && params.q !== '') qs.set('q', params.q);
    if (params.types?.length) qs.set('types', params.types.join(','));
    if (params.depth !== undefined && params.depth > 0) qs.set('depth', String(params.depth));
    if (params.limit !== undefined) qs.set('limit', String(params.limit));
    if (params.offset !== undefined) qs.set('offset', String(params.offset));
    if (params.includeHidden) qs.set('includeHidden', 'true');
    return http<NodesResponse>(`/api/p/${encodeURIComponent(project)}/nodes?${qs}`);
  },

  loadNode: (project: string, id: string, depth = 10) =>
    http<NodeDetailResponse>(`/api/p/${encodeURIComponent(project)}/nodes/${encodeURIComponent(id)}?depth=${depth}`),

  loadRefs: (project: string, id: string) =>
    http<RefsResponse>(`/api/p/${encodeURIComponent(project)}/nodes/${encodeURIComponent(id)}/refs`),

  listJobs: (project: string) =>
    http<JobRow[]>(`/api/p/${encodeURIComponent(project)}/jobs`),
  setJobEnabled: (project: string, job: string, enabled: boolean) =>
    http<{ name: string; enabled: boolean }>(
      `/api/p/${encodeURIComponent(project)}/jobs/${encodeURIComponent(job)}/enabled`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      },
    ),
  triggerJob: (project: string, job: string) =>
    http<{ queued: string }>(`/api/p/${encodeURIComponent(project)}/jobs/${encodeURIComponent(job)}/trigger`, {
      method: 'POST',
    }),

  scheduler: (project: string) =>
    http<SchedulerStatus>(`/api/p/${encodeURIComponent(project)}/scheduler`),
};
