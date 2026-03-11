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
  | { kind: 'OrType'; left: Type; right: Type }
  | { kind: 'AndType'; left: Type; right: Type }
  | { kind: 'MapType'; entries: Record<Sym, Type> }
  /**
   * A named type reference — points to a type registered in named_types by name.
   * Stored as a single lightweight row in the types table; resolved at load time.
   * Enables graph (not tree) storage and supports circular type definitions.
   */
  | { kind: 'RefType'; name: string }
  /**
   * Marks a map field as optional — the field may be absent when inserting or
   * loading. Wraps any inner type. YAML shorthand: append `?` to the type name
   * (e.g. `Meaning?`, `Symbol?`, `Location?`) or use `kind: Optional`.
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
}

export interface StoredType {
  id: string;
  kind: 'SymbolType' | 'MeaningType' | 'ListType' | 'OrType' | 'AndType' | 'MapType' | 'RefType' | 'OptionalType';
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
  | { kind: 'map'; entries: Record<Sym, DeepNode>; type: Type; typeName?: string }
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
