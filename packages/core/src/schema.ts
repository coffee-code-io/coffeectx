/**
 * SQLite schema DDL.
 * Requires sqlite-vec extension for vec0 virtual tables.
 */
export const SCHEMA_DDL = `
-- Nodes: polymorphic store for all atom/list/map nodes
CREATE TABLE IF NOT EXISTS nodes (
  id          TEXT    PRIMARY KEY,
  kind        TEXT    NOT NULL CHECK(kind IN ('symbol', 'meaning', 'list', 'map')),
  symbol_value TEXT,           -- set when kind='symbol'
  meaning_text TEXT,           -- set when kind='meaning'
  type_id     TEXT REFERENCES types(id),  -- set when kind='map'
  -- Per-node state, valid only for named-type maps. NULL means the type has
  -- no declared state machine (default [ready]) and the node is at its
  -- single, final state.
  state       TEXT
);

-- List contents (ordered)
CREATE TABLE IF NOT EXISTS list_items (
  list_id  TEXT    NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  item_id  TEXT    NOT NULL REFERENCES nodes(id),
  PRIMARY KEY (list_id, position)
);

-- Map entries: symbol key → node value
CREATE TABLE IF NOT EXISTS map_entries (
  map_id   TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  key      TEXT NOT NULL,   -- symbol
  value_id TEXT NOT NULL REFERENCES nodes(id),
  PRIMARY KEY (map_id, key)
);

-- Types: schema nodes.
-- ref_name    is set when kind='RefType' — stores the named_types.name being referenced.
-- content_key is a deterministic structural fingerprint used to deduplicate structural
--             types across re-sync runs (NULL for the two singleton leaf types).
CREATE TABLE IF NOT EXISTS types (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK(kind IN (
    'SymbolType', 'MeaningType', 'ListType', 'OrType', 'MapType', 'RefType', 'OptionalType'
  )),
  ref_name    TEXT,
  content_key TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_types_content_key
  ON types(content_key) WHERE content_key IS NOT NULL;

-- Composite type children:
--   ListType:     pos=0 is itemType
--   OrType:       pos=0..N-1 are the N flat variants (no nested Or)
--   OptionalType: pos=0 is the inner type
CREATE TABLE IF NOT EXISTS type_children (
  type_id       TEXT    NOT NULL REFERENCES types(id) ON DELETE CASCADE,
  position      INTEGER NOT NULL,
  child_type_id TEXT    NOT NULL REFERENCES types(id),
  PRIMARY KEY (type_id, position)
);

-- MapType field definitions
CREATE TABLE IF NOT EXISTS type_map_entries (
  type_id       TEXT NOT NULL REFERENCES types(id) ON DELETE CASCADE,
  key           TEXT NOT NULL,   -- symbol
  value_type_id TEXT NOT NULL REFERENCES types(id),
  PRIMARY KEY (type_id, key)
);

-- Ordered state machine per named type. Types without rows here behave as
-- [ready] (single, final). The final state is the row with the highest
-- position; upserts on a node in its final state are rejected.
CREATE TABLE IF NOT EXISTS named_type_states (
  type_name TEXT    NOT NULL,
  position  INTEGER NOT NULL,
  state     TEXT    NOT NULL,
  PRIMARY KEY (type_name, position)
);
CREATE INDEX IF NOT EXISTS idx_named_type_states_name ON named_type_states(type_name);

-- Named types: human-readable names → type_id.
-- source distinguishes 'builtin' (shipped YAML) from 'user' (custom).
-- hidden=1 means entries of this type are excluded from search/exact/regex by default.
CREATE TABLE IF NOT EXISTS named_types (
  name        TEXT PRIMARY KEY,
  type_id     TEXT NOT NULL REFERENCES types(id),
  description TEXT,
  source      TEXT NOT NULL DEFAULT 'user',
  hidden      INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Jobs registry: one row per scheduler-managed job.
-- enabled mirrors the config setting on boot (config wins on reconcile).
-- current_run_id is non-null while the job is executing.
-- state_json stores arbitrary per-job state: catch-up cursors, file hashes,
-- per-skill progress, etc. The scheduler owns its shape per-job.
CREATE TABLE IF NOT EXISTS jobs (
  name              TEXT PRIMARY KEY,
  description       TEXT,
  enabled           INTEGER NOT NULL DEFAULT 1,
  status            TEXT NOT NULL DEFAULT 'idle',
  current_run_id    INTEGER,
  last_started_at   TEXT,
  last_ended_at     TEXT,
  last_result       TEXT,
  last_error        TEXT,
  last_message      TEXT,
  last_metrics_json TEXT,
  trigger_pending   INTEGER NOT NULL DEFAULT 0,
  state_json        TEXT
);

-- Scheduler heartbeat: single row, updated periodically by the running scheduler.
-- The UI consults this to show a green/red "alive" indicator.
CREATE TABLE IF NOT EXISTS scheduler_heartbeats (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  last_seen_at  TEXT    NOT NULL,
  pid           INTEGER
);

-- Job execution history.
CREATE TABLE IF NOT EXISTS job_runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  job_name     TEXT NOT NULL,
  trigger_kind TEXT NOT NULL,
  started_at   TEXT NOT NULL,
  ended_at     TEXT,
  result       TEXT,
  message      TEXT,
  error        TEXT,
  metrics_json TEXT
);

-- Plan acceptance log — hidden from the MCP/UI graph. One row per session
-- that ran ExitPlanMode against a given plan. Populated by the agent-log
-- indexer; consumed by the plans indexer (to skip orphan plans / fill in
-- Plan.acceptedBy) and by the LSP reverse pass (to derive each plan's file
-- context from its accepting sessions' FileOperations).
CREATE TABLE IF NOT EXISTS plan_acceptances (
  plan_slug   TEXT NOT NULL,
  session_id  TEXT NOT NULL,     -- namespaced "claude:<uuid>" / "codex:<id>" / "pi:<id>"
  timestamp   TEXT NOT NULL,
  PRIMARY KEY (plan_slug, session_id)
);
CREATE INDEX IF NOT EXISTS idx_plan_acceptances_session ON plan_acceptances(session_id);

-- Per-event file context — hidden from the MCP/UI graph. For each text event
-- (UserInput / AgentMessage / AgentSummary / AgentQuestion), records the
-- file path(s) the event is "about" in its session, computed from the nearby
-- Write/Edit tool calls. The enricher and the LSP reverse pass consult this
-- table to restrict identifier resolution and reverse-linking to symbols
-- whose source file is in the event's allowed set.
CREATE TABLE IF NOT EXISTS event_file_context (
  event_id   TEXT NOT NULL,    -- node id of the event (UserInput/AgentMessage/etc.)
  file_path  TEXT NOT NULL,    -- file path from the nearest Edit/Write boundary
  PRIMARY KEY (event_id, file_path)
);
CREATE INDEX IF NOT EXISTS idx_event_file_context_path ON event_file_context(file_path);

-- Materialized edge index between named-type nodes.
-- Populated by insertEntries / rebuildNodeRefs; read by findReferencingNamedNodes
-- and collectOutgoingNamedRefs to power the graph view and detail-page "refs".
-- One row per (src, dst, field_path); src/dst are both named-type node IDs.
CREATE TABLE IF NOT EXISTS node_refs (
  src_id     TEXT NOT NULL,
  dst_id     TEXT NOT NULL,
  field_path TEXT NOT NULL,
  src_type   TEXT NOT NULL,
  dst_type   TEXT NOT NULL,
  PRIMARY KEY (src_id, dst_id, field_path)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_nodes_kind         ON nodes(kind);
CREATE INDEX IF NOT EXISTS idx_list_items_list    ON list_items(list_id);
CREATE INDEX IF NOT EXISTS idx_map_entries_map    ON map_entries(map_id);
CREATE INDEX IF NOT EXISTS idx_type_children_type ON type_children(type_id);
CREATE INDEX IF NOT EXISTS idx_type_map_type      ON type_map_entries(type_id);
CREATE INDEX IF NOT EXISTS idx_job_runs_job       ON job_runs(job_name, started_at);
CREATE INDEX IF NOT EXISTS idx_node_refs_dst      ON node_refs(dst_id);
CREATE INDEX IF NOT EXISTS idx_node_refs_src      ON node_refs(src_id);
`;

/** Generate the DDL for the sqlite-vec virtual table with the given embedding dimension. */
export function makeVecTableDDL(dims: number): string {
  return `
CREATE VIRTUAL TABLE IF NOT EXISTS meaning_vecs USING vec0(
  node_id TEXT PRIMARY KEY,
  embedding float[${dims}]
);
`;
}

/** @deprecated Use makeVecTableDDL(dims) instead. */
export const VEC_TABLE_DDL = makeVecTableDDL(1536);
