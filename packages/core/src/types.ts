/**
 * Grammar:
 *   symbol  = string
 *   meaning = string ',' vec128
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
  vec: Float32Array; // exactly 128 dimensions
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
 * To create a circular reference between entries in the same batch,
 * use `{ "$ref": N }` as a field value, where N is the 0-based index
 * of the target entry in the entries array.
 */
export interface InsertEntry {
  type: string;
  data: Record<string, unknown>;
}

export interface InsertResult {
  /** IDs of successfully inserted top-level nodes, in input order. Null where type validation failed. */
  ids: (string | null)[];
  errors: Array<{ index: number; path: string; message: string }>;
}

export interface SearchResult {
  nodeId: string;
  node: Node;
  distance: number;
}

export type EmbedFn = (text: string) => Promise<Float32Array>;
