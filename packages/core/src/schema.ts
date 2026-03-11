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
  type_id     TEXT REFERENCES types(id)  -- set when kind='map'
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
    'SymbolType', 'MeaningType', 'ListType', 'OrType', 'AndType', 'MapType', 'RefType', 'OptionalType'
  )),
  ref_name    TEXT,
  content_key TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_types_content_key
  ON types(content_key) WHERE content_key IS NOT NULL;

-- Composite type children (ListType: pos=0 is itemType; OrType/AndType: pos=0=left, pos=1=right)
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

-- Skills: prompt-based indexing recipes that reference a set of named types.
CREATE TABLE IF NOT EXISTS skills (
  name        TEXT PRIMARY KEY,
  description TEXT,
  prompt      TEXT NOT NULL,
  source      TEXT NOT NULL DEFAULT 'user',
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Ordered list of type references per skill.
CREATE TABLE IF NOT EXISTS skill_types (
  skill_name TEXT    NOT NULL REFERENCES skills(name) ON DELETE CASCADE,
  type_name  TEXT    NOT NULL REFERENCES named_types(name),
  position   INTEGER NOT NULL,
  PRIMARY KEY (skill_name, position)
);

CREATE INDEX IF NOT EXISTS idx_skill_types_skill ON skill_types(skill_name);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_nodes_kind         ON nodes(kind);
CREATE INDEX IF NOT EXISTS idx_list_items_list    ON list_items(list_id);
CREATE INDEX IF NOT EXISTS idx_map_entries_map    ON map_entries(map_id);
CREATE INDEX IF NOT EXISTS idx_type_children_type ON type_children(type_id);
CREATE INDEX IF NOT EXISTS idx_type_map_type      ON type_map_entries(type_id);
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
