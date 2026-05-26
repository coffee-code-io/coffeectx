/**
 * Grammar:
 *   symbol  = string
 *   meaning = string ',' vec
 *   atom    = symbol | meaning
 *   node    = atom | list | map ':' type
 *   map     = 'Map' | map symbol ':' node ';'
 *   list    = 'List' | list node ','
 *   type    = 'SymbolType' | 'MeaningType' | map_type | List type | OR type type | AND type type
 *   map_type = 'MapType' | map_type symbol ':' type ';'
 */

// Primitives
export type Sym = string;

export interface Meaning {
  text: string;
  vec: Float32Array; // dimension determined by the DB's embed config
}

// Atom
export type Atom =
  | { kind: 'symbol'; value: Sym }
  | { kind: 'meaning'; value: Meaning };

// Recursive node structure
export type Node =
  | { kind: 'atom'; atom: Atom }
  | { kind: 'list'; items: Node[] }
  | { kind: 'map'; entries: Record<Sym, Node>; type: Type };

// Type system — schemas community can define and compose
export type Type =
  | { kind: 'SymbolType' }
  | { kind: 'MeaningType' }
  | { kind: 'ListType'; itemType: Type }
  /**
   * A union of types — the field's value must satisfy at least one variant.
   * Stored as N rows in `type_children` (positions 0..N-1). Direct nesting
   * `Or<Or<...>>` and `Or<Optional<...>>` is rejected at YAML resolve time,
   * so the variants are guaranteed flat at the data layer.
   */
  | { kind: 'OrType'; variants: Type[] }
  | { kind: 'MapType'; entries: Record<Sym, Type> }
  /**
   * A named type reference — points to a type registered in named_types by name.
   * Stored as a single lightweight row in the types table; resolved at load time.
   * Enables graph (not tree) storage and supports circular type definitions.
   *
   * Named **Or** and **Optional** types are NOT stored as RefType — they're
   * inlined at YAML resolve time, so a `RefType` always resolves to a concrete
   * named map / list / atom shape.
   */
  | { kind: 'RefType'; name: string }
  /**
   * Marks a map field as optional — the field may be absent when inserting or
   * loading. Wraps any inner type. YAML shorthand: append `?` to the type name
   * (e.g. `Meaning?`, `Symbol?`, `Location?`) or use `kind: Optional`.
   * Optional cannot wrap an Or or another Optional directly.
   */
  | { kind: 'OptionalType'; inner: Type };

// DB-level representations (with stable IDs for storage)
export interface StoredNode {
  id: string;
  kind: 'symbol' | 'meaning' | 'list' | 'map';
  // For atoms
  symbolValue?: string;
  meaningText?: string;
  // meaningVec stored separately in vec0 virtual table
  // For maps
  typeId?: string;
  /** Unix ms, set only on `kind='map'` rows. */
  createdAt?: number;
  /** Unix ms, set only on `kind='map'` rows. */
  updatedAt?: number;
  /** Always populated; for unversioned nodes equals `id`. */
  timelineId?: string;
  /** Always populated; defaults to 1. Bumps on `bumpVersion` upserts. */
  version?: number;
  /** 1 iff the row is hidden from search-path queries. The row remains
   *  loadable by exact id. Set by version bumps (prior versions) and
   *  by the `delete` flag on `upsertEntries`. */
  tombstone?: boolean;
}

export interface StoredType {
  id: string;
  kind: 'SymbolType' | 'MeaningType' | 'ListType' | 'OrType' | 'MapType' | 'RefType' | 'OptionalType';
  refName?: string; // set when kind='RefType'
}

/**
 * A node loaded with configurable depth.
 * - `ref`   — depth limit reached; use the `id` to load further.
 * - `cycle` — this `id` is an ancestor in the current load path; expanding it
 *             would be infinite recursion.
 * All other variants mirror `Node` but with `DeepNode` children.
 */
export type DeepNode =
  | { kind: 'atom'; atom: Atom }
  | { kind: 'list'; items: DeepNode[] }
  | {
      kind: 'map';
      id?: string;
      entries: Record<Sym, DeepNode>;
      type: Type;
      typeName?: string;
      state?: string;
      /** Unix ms. Present iff the node was loaded from a stored row. */
      createdAt?: number;
      /** Unix ms. Present iff the node was loaded from a stored row. */
      updatedAt?: number;
      /** Always populated; for unversioned nodes equals `id`. */
      timelineId?: string;
      /** Always populated; 1-based version within the timeline. */
      version?: number;
      /** True iff the node is tombstoned (deleted or superseded). The
       *  exact id still loads — debug-mode UIs can surface the row. */
      tombstone?: boolean;
    }
  | { kind: 'ref'; id: string }
  | { kind: 'cycle'; id: string };

/**
 * A single entry to insert via `Db.insertEntries`.
 * `type` must be a named type whose schema is a MapType.
 * `data` provides field values; missing fields are skipped.
 *
 * To reference another entry in the same batch, use `{ "$ref": N }` where N
 * is the 0-based index of the target entry.
 * To reference a node already in the DB, use `{ "$id": "uuid" }`.
 */
export interface InsertEntry {
  type: string;
  data: Record<string, unknown>;
  /**
   * If provided, patch this existing map node instead of creating a new one.
   * Only fields absent on the node are added; existing keys are skipped.
   * Required-field validation is relaxed — partial data is accepted.
   */
  id?: string;
  /**
   * Optional target state. For inserts: persists with this state instead of
   * the type's first state. For patches: bumps the node to this state if it
   * differs from the current one. Must be a member of the type's declared
   * state machine. Patches on a node already in the final state without an
   * explicit `$state` are rejected as immutable.
   */
  state?: string;
  /**
   * Optional explicit `created_at` / `updated_at` overrides (Unix
   * milliseconds since epoch). Tools accept ISO strings or numbers and
   * normalise to ms here.
   *
   * On inserts: both default to `Date.now()` when omitted.
   * On patches: `updated_at` defaults to `Date.now()` (always bumped);
   *   `createdAt` is ignored (the original creation timestamp is preserved).
   */
  createdAt?: number;
  updatedAt?: number;
  /**
   * Only meaningful with `id` set, and only valid for types declaring
   * `withHistory: true`. Allocates a fresh node id and links it into
   * the same `timeline_id` as the referenced node with `version + 1`,
   * applying `data` as a shallow patch (unchanged fields are kept;
   * `null` values explicitly clear a field). Bypasses the final-state
   * immutability check — this IS the way to "edit" a finalised node.
   * The new version resets to the type's first declared state unless
   * `state` is supplied; `createdAt` is inherited from the prior
   * version; `updatedAt` is set to now.
   *
   * Sourced from the `upsertEntries` tool's top-level `bumpVersion`
   * param (not a per-entry DTO field); applied uniformly to every
   * entry in the batch by the tool layer before reaching `Db`.
   */
  bumpVersion?: boolean;
  /**
   * Only meaningful with `id` set, and only valid for types declaring
   * `withHistory: true`. Tombstones the current version (and its
   * anonymous subtree) so the timeline disappears from every search
   * path and from `node_refs`. The row stays loadable by exact id.
   *
   * Sourced from the `upsertEntries` tool's top-level `delete` flag;
   * mutually exclusive with `bumpVersion`.
   */
  delete?: boolean;
}

export interface InsertResult {
  /** IDs of top-level nodes in input order. For new entries: the new ID (null on failure). For patches: the existing node ID. */
  ids: (string | null)[];
  errors: Array<{ index: number; path: string; message: string }>;
  /** Per-entry lists of keys skipped because they already existed (only meaningful for patch entries). */
  skippedKeys: string[][];
}

export interface SearchResult {
  nodeId: string;
  node: Node;
  distance: number;
}

export type EmbedFn = (text: string) => Promise<Float32Array>;
