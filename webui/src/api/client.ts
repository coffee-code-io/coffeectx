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
  /** True if the server forced depth=0 because the request had no `q` filter. */
  depthForced?: boolean;
}

export type RefsBatchResponse = Record<string, RefsResponse>;

/**
 * Aux-table payload the server attaches to the node-detail response when
 * the global `debug` flag is on. Discriminated by `kind`. Absent when
 * the flag's off or when the node type has no aux data to surface.
 * Mirror of `NodeDebugInfo` in indexer/src/ui/debugInfo.ts.
 */
export type NodeDebugInfo = {
  /** Per-node JSON written via `db.debugSet(nodeId, field, value)`.
   *  Indexed by field name; values are the original JSON-parsed shapes. */
  debug: Record<string, unknown>;
};

/** One row of `db.listTimelineVersions(timelineId)` — every version of a
 *  timeline ordered ascending. Always present in `NodeDetailResponse`
 *  (length 1 for unversioned types, where the node's `timeline_id`
 *  equals its `id`). */
export interface TimelineVersionRow {
  id: string;
  version: number;
  createdAt: number | null;
  tombstone: boolean;
}

export interface NodeDetailResponse {
  id: string;
  typeName: string | null;
  /** Current state-machine slot for named-type nodes; null for untyped or
   * pre-state-machine nodes. Surfaced in the header chip. */
  state: string | null;
  node: unknown;
  /** All versions of the timeline this node belongs to. Length === 1
   *  means the node is unversioned (no nav arrows). */
  versions: TimelineVersionRow[];
  /** Optional aux-table payload; populated only when the server's
   * `debug` flag is on. Renderable iff present. */
  debug?: NodeDebugInfo;
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
  /** 'user' = backed by a SKILL.md in ~/.coffeecode/jobs/; 'system' =
   *  hardcoded built-in (claude / codex / lsp / etc). */
  category: 'system' | 'user';
  /** True iff the project has any entry in `projects.<p>.jobs[<name>]` in
   *  config.yaml. Drives the Configured / Available split. */
  configured: boolean;
}

export interface SchedulerStatus {
  alive: boolean;
  lastSeenAt: string | null;
  pid: number | null;
}

export interface JobRunRow {
  id: number;
  jobName: string;
  triggerKind: 'timer' | 'onTypeInsert' | 'onNodeState' | 'cron' | 'manual' | 'startup';
  startedAt: string;
  endedAt: string | null;
  result: 'ok' | 'error' | 'cancelled' | null;
  message: string | null;
  error: string | null;
  metrics: Record<string, number> | null;
}

export interface RunDetailResponse {
  run: JobRunRow;
  log: string | null;
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

  /** Global debug flag from ~/.coffeecode/config.yaml. Fetched once on
   *  bootstrap; the result lives in zustand for synchronous reads. */
  getDebug: () => http<{ debug: boolean }>('/api/debug'),
  setProjectEnabled: (name: string, enabled: boolean) =>
    http<{ name: string; enabled: boolean }>(`/api/projects/${encodeURIComponent(name)}/enabled`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    }),

  /** Tell the UI server to drop its cached Db handle for this project.
   *  Required after an external `restore` / `reset` swapped the SQLite
   *  file — the server's held connection would otherwise keep serving
   *  stale rows. Idempotent: returns reopened=false if no handle was open. */
  refreshProject: (name: string) =>
    http<{ name: string; reopened: boolean }>(`/api/projects/${encodeURIComponent(name)}/refresh`, {
      method: 'POST',
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

  loadRefsBatch: (project: string, ids: string[]) =>
    http<RefsBatchResponse>(`/api/p/${encodeURIComponent(project)}/refs/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    }),

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

  listRuns: (project: string, limit = 100) =>
    http<JobRunRow[]>(`/api/p/${encodeURIComponent(project)}/runs?limit=${limit}`),

  getRun: (project: string, runId: number) =>
    http<RunDetailResponse>(`/api/p/${encodeURIComponent(project)}/runs/${runId}`),

  // ── Interactive UI agent ──────────────────────────────────────────────────
  sendAgentMessage: (project: string, text: string) =>
    http<{ ok: true }>(`/api/p/${encodeURIComponent(project)}/agent/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    }),
  listAgentSessions: (project: string) =>
    http<{ sessions: UiAgentSessionInfo[] }>(`/api/p/${encodeURIComponent(project)}/agent/sessions`),
  newAgentSession: (project: string) =>
    http<{ ok: true; activeSessionPath?: string }>(`/api/p/${encodeURIComponent(project)}/agent/sessions/new`, {
      method: 'POST',
    }),
  activateAgentSession: (project: string, path: string) =>
    http<{ ok: true; activeSessionPath?: string }>(`/api/p/${encodeURIComponent(project)}/agent/sessions/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    }),
  deleteAgentSession: (project: string, path: string) =>
    http<{ ok: true; activeSessionPath?: string }>(`/api/p/${encodeURIComponent(project)}/agent/sessions/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    }),
  /** URL for the SSE stream — pass to EventSource. */
  agentStreamUrl: (project: string) => `/api/p/${encodeURIComponent(project)}/agent/stream`,

  // ── Skills registry / configure ───────────────────────────────────────────
  listSkills: (project: string) =>
    http<SkillsListResponse>(`/api/p/${encodeURIComponent(project)}/skills`),
  configureSkill: (project: string, name: string, body: SkillConfigurePatch) =>
    http<{ ok: true }>(`/api/p/${encodeURIComponent(project)}/skills/${encodeURIComponent(name)}/configure`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  setSkillFilter: (project: string, body: SkillFilterPatch) =>
    http<{ ok: true }>(`/api/p/${encodeURIComponent(project)}/skills/filter`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),

  // ── Secrets ──────────────────────────────────────────────────────────────
  getSecrets: (project: string) =>
    http<SecretsResponse>(`/api/p/${encodeURIComponent(project)}/secrets`),
  setSecretsProject: (project: string, secretsProject: string | null) =>
    http<SecretsResponse>(`/api/p/${encodeURIComponent(project)}/secrets/secretsProject`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secretsProject }),
    }),
  createWhitelist: (project: string, body: WhitelistRuleInput) =>
    http<SecretsResponse>(`/api/p/${encodeURIComponent(project)}/secrets/whitelist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  updateWhitelist: (project: string, index: number, body: WhitelistRuleInput) =>
    http<SecretsResponse>(`/api/p/${encodeURIComponent(project)}/secrets/whitelist/${index}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  deleteWhitelist: (project: string, index: number) =>
    http<SecretsResponse>(`/api/p/${encodeURIComponent(project)}/secrets/whitelist/${index}`, {
      method: 'DELETE',
    }),
  hashFile: (project: string, path: string) =>
    http<HashResponse>(`/api/p/${encodeURIComponent(project)}/secrets/hash`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    }),
};

export type SkillFilterTarget = 'uiAgent' | 'indexingAgents' | 'jobs';
export type SkillCategory = 'skill' | 'job';

export interface SkillFilter {
  include?: string[];
  exclude?: string[];
}

export interface SkillInfo {
  name: string;
  description: string | null;
  category: SkillCategory;
  hasJob: boolean;
  hasTypes: boolean;
  requiredEnv: string[];
  configuredEnvKeys: string[];
  /** Current env var values from config.yaml. Shown as plain text in the
   *  Configure dialog — these are agent-visible and not treated as
   *  secret. Keys without an entry are simply absent. */
  env: Record<string, string>;
  authConfigured: boolean;
  auth: {
    authType: string | null;
    model: string | null;
    hasApiKey: boolean;
  };
  /** Config-override triggers, if set. `null` means "use SKILL.md default". */
  triggers: unknown[] | null;
  enabled: boolean;
  visibleTo: Record<SkillFilterTarget, boolean>;
}

export interface SkillsListResponse {
  skills: SkillInfo[];
  filters: Record<SkillFilterTarget, SkillFilter>;
}

export interface SkillAuthPatch {
  authType?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
}

export interface SkillConfigurePatch {
  enabled?: boolean;
  env?: Record<string, string>;
  auth?: SkillAuthPatch;
  /** `null` clears the override (re-enables SKILL.md default). */
  triggers?: unknown[] | null;
}

export interface SkillFilterPatch {
  target: SkillFilterTarget;
  /** `null` clears that side of the filter. Omit to leave untouched. */
  include?: string[] | null;
  exclude?: string[] | null;
}

export interface UiAgentSessionInfo {
  path: string;
  id: string;
  name?: string;
  created: string;
  modified: string;
  messageCount: number;
  firstMessage: string;
  isActive: boolean;
}

// ── Secrets ────────────────────────────────────────────────────────────────

export interface FileEntryView {
  path: string;
  hash: string;
  exists: boolean;
  currentHash?: string;
  matches?: boolean;
}

export interface WhitelistRuleView {
  command: string;
  files: FileEntryView[];
  allowed_env: string[];
  secrets: string[];
}

export interface SecretsResponse {
  /** Effective secrets-project name — `ProjectEntry.secretsProject` if set,
   *  else the coffeectx project name itself. */
  secretsProject: string;
  /** True iff `secretsProject` exists in `~/.coffeecode/secrets.yaml`. */
  exists: boolean;
  directory?: string;
  /** Names of secrets defined under the project. Values stay in YAML. */
  secretNames: string[];
  whitelist: WhitelistRuleView[];
  /** Absolute path of `~/.coffeecode/secrets.yaml` (for the empty-state hint). */
  configPath: string;
}

export interface WhitelistRuleInput {
  command: string;
  /** Paths only — server computes hashes authoritatively on save. */
  files: { path: string }[];
  allowed_env: string[];
  secrets: string[];
}

export interface HashResponse {
  path: string;
  exists: boolean;
  hash?: string;
}
