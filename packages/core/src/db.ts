import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { v4 as uuidv4 } from 'uuid';
import { SCHEMA_DDL, makeVecTableDDL } from './schema.js';
import type { Node, Type, Atom, Sym, EmbedFn, SearchResult, StoredNode, DeepNode, InsertEntry, InsertResult } from './types.js';
import type { QueryDb } from './query.js';

import { log } from './logger.js';

export interface DbOptions {
  path: string;
  embed: EmbedFn;
  /** Embedding dimension. Must match the model's output size. Defaults to 1536. */
  dimensions?: number;
}

export class Db implements QueryDb {
  private readonly raw: Database.Database;
  private readonly embed: EmbedFn;
  readonly dims: number;

  constructor(options: DbOptions) {
    this.raw = new Database(options.path);
    this.embed = options.embed;
    this.dims = options.dimensions ?? 1536;

    sqliteVec.load(this.raw);
    this.raw.pragma('journal_mode = WAL');
    this.raw.pragma('foreign_keys = ON');

    // Register REGEXP custom function for querySymbolRegex
    this.raw.function('regexp', (pattern: unknown, str: unknown) =>
      new RegExp(pattern as string, 'i').test(str as string) ? 1 : 0,
    );

    this.raw.exec(SCHEMA_DDL);
    this.raw.exec(makeVecTableDDL(this.dims));
    this.migrate();
  }

  /** Non-destructive migrations for columns added after initial release. */
  private migrate(): void {
    // named_types.description (pre-skills schema)
    try { this.raw.exec(`ALTER TABLE named_types ADD COLUMN description TEXT`); } catch { /* ok */ }

    // named_types.hidden (post-initial schema)
    try { this.raw.exec(`ALTER TABLE named_types ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0`); } catch { /* ok */ }

    // types.ref_name (pre-RefType schema)
    try { this.raw.exec(`ALTER TABLE types ADD COLUMN ref_name TEXT`); } catch { /* ok */ }

    // types.content_key (pre-dedup schema)
    try { this.raw.exec(`ALTER TABLE types ADD COLUMN content_key TEXT`); } catch { /* ok */ }

    // Unique index on content_key (idempotent)
    try {
      this.raw.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_types_content_key ON types(content_key) WHERE content_key IS NOT NULL`,
      );
    } catch { /* ok */ }

    // Recreate types table if the old CHECK constraint blocks 'RefType'.
    try {
      this.raw.exec(`INSERT INTO types(id, kind) VALUES('__reftype_probe__', 'RefType')`);
      this.raw.exec(`DELETE FROM types WHERE id='__reftype_probe__'`);
    } catch {
      this.raw.pragma('foreign_keys = OFF');
      this.raw.exec(`
        CREATE TABLE types_new (
          id          TEXT PRIMARY KEY,
          kind        TEXT NOT NULL CHECK(kind IN (
            'SymbolType','MeaningType','ListType','OrType','AndType','MapType','RefType','OptionalType'
          )),
          ref_name    TEXT,
          content_key TEXT
        );
        INSERT INTO types_new(id, kind, ref_name)
          SELECT id, kind, ref_name FROM types;
        DROP TABLE types;
        ALTER TABLE types_new RENAME TO types;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_types_content_key
          ON types(content_key) WHERE content_key IS NOT NULL;
      `);
      this.raw.pragma('foreign_keys = ON');
    }

    // Recreate types table if the CHECK constraint doesn't include 'OptionalType'.
    try {
      this.raw.exec(`INSERT INTO types(id, kind) VALUES('__opttype_probe__', 'OptionalType')`);
      this.raw.exec(`DELETE FROM types WHERE id='__opttype_probe__'`);
    } catch {
      this.raw.pragma('foreign_keys = OFF');
      this.raw.exec(`
        CREATE TABLE types_new (
          id          TEXT PRIMARY KEY,
          kind        TEXT NOT NULL CHECK(kind IN (
            'SymbolType','MeaningType','ListType','OrType','AndType','MapType','RefType','OptionalType'
          )),
          ref_name    TEXT,
          content_key TEXT
        );
        INSERT INTO types_new(id, kind, ref_name)
          SELECT id, kind, ref_name FROM types;
        DROP TABLE types;
        ALTER TABLE types_new RENAME TO types;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_types_content_key
          ON types(content_key) WHERE content_key IS NOT NULL;
      `);
      this.raw.pragma('foreign_keys = ON');
    }

    // Recreate types table if the CHECK constraint doesn't include 'RefType' and 'OptionalType'.
    try {
      this.raw.exec(`INSERT INTO types(id, kind) VALUES('__reftypeopt_probe__', 'RefType')`);
      this.raw.exec(`DELETE FROM types WHERE id='__reftypeopt_probe__'`);
    } catch {
      this.raw.pragma('foreign_keys = OFF');
      this.raw.exec(`
        CREATE TABLE types_new (
          id          TEXT PRIMARY KEY,
          kind        TEXT NOT NULL CHECK(kind IN (
            'SymbolType','MeaningType','ListType','OrType','AndType','MapType','RefType','OptionalType'
          )),
          ref_name    TEXT,
          content_key TEXT
        );
        INSERT INTO types_new(id, kind, ref_name)
          SELECT id, kind, ref_name FROM types;
        DROP TABLE types;
        ALTER TABLE types_new RENAME TO types;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_types_content_key
          ON types(content_key) WHERE content_key IS NOT NULL;
      `);
      this.raw.pragma('foreign_keys = ON');
    }

    // Recreate types table if the CHECK constraint doesn't include 'RefType' and 'OptionalType' (second attempt).
    try {
      this.raw.exec(`INSERT INTO types(id, kind) VALUES('__reftypeopt_probe2__', 'RefType')`);
      this.raw.exec(`DELETE FROM types WHERE id='__reftypeopt_probe2__'`);
    } catch {
      this.raw.pragma('foreign_keys = OFF');
      this.raw.exec(`
        CREATE TABLE types_new (
          id          TEXT PRIMARY KEY,
          kind        TEXT NOT NULL CHECK(kind IN (
            'SymbolType','MeaningType','ListType','OrType','AndType','MapType','RefType','OptionalType'
          )),
          ref_name    TEXT,
          content_key TEXT
        );
        INSERT INTO types_new(id, kind, ref_name)
          SELECT id, kind, ref_name FROM types;
        DROP TABLE types;
        ALTER TABLE types_new RENAME TO types;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_types_content_key
          ON types(content_key) WHERE content_key IS NOT NULL;
      `);
      this.raw.pragma('foreign_keys = ON');
    }
  }

  /**
   * Check if a value is a reference object (`{ "$ref": N }` or `{ "$id": "uuid" }`).
   */
  isRefValue(value: unknown): boolean {
    if (typeof value !== 'object' || value === null) return false;
    return '$ref' in value || '$id' in value;
  }

  /**
   * Resolve a reference value to a UUID.
   * `{ "$ref": N }` resolves to the pre-allocated ID of the N-th top-level entry.
   * `{ "$id": "uuid" }` references an existing node already in the DB.
   */
  resolveRefValue(value: unknown): string | null {
    if (typeof value !== 'object' || value === null) return null;
    if ('$ref' in value && typeof (value as any).$ref === 'number') {
      return (value as any).$ref;
    }
    if ('$id' in value && typeof (value as any).$id === 'string') {
      return (value as any).$id;
    }
    return null;
  }

  /**
   * Build (insert) a node for a single field value given its shallow schema type.
   * Called inside the transaction; must be synchronous.
   *
   * `{ "$ref": N }` resolves to the pre-allocated ID of the N-th top-level entry.
   * `{ "$id": "uuid" }` references an existing node already prese
   */
  buildNodeForValue(value: unknown, schema: Type, entryIndex?: number): string {
    if (value === undefined) {
      return this.insertEntry({ $type: 'Undefined' });
    }
    
    if (this.isRefValue(value)) {
      const ref = this.resolveRefValue(value);
      if (ref === null) {
        throw new Error(`Invalid reference value: ${JSON.stringify(value)}`);
      }
      if (typeof ref === 'number') {
        // $ref: N — must be resolved to an entry index
        return { $ref: ref };
      }
      // $id: "uuid" — already a UUID, just return it
      return ref;
    }

    // Handle undefined explicitly
    if (value === undefined) {
      return this.insertEntry({ $type: 'Undefined' });
    }

    const typeId = this.getTypeId(schema);
    const vec = this.embed(value);

    switch (schema.$kind) {
      case 'SymbolType':
        return this.insertEntry({
          $type: 'Symbol',
          value: String(value),
          typeId: typeId,
          vec: vec,
        });

      case 'MeaningType':
        return this.insertEntry({
          $type: 'Meaning',
          value: String(value),
          typeId: typeId,
          vec: vec,
        });

      case 'ListType':
        if (!Array.isArray(value)) {
          throw new Error(`Expected array for ListType, got ${typeof value}`);
        }
        const listId = this.insertEntry({
          $type: 'List',
          typeId: typeId,
          vec: vec,
        });
        const itemSchema = (schema as any).item;
        for (const item of value) {
          const itemId = this.buildNodeForValue(item, itemSchema, entryIndex);
          this.raw.prepare('INSERT INTO list_items(listId, itemId) VALUES (?, ?)').run(listId, itemId);
        }
        return listId;

      case 'OrType':
      case 'AndType':
      case 'MapType':
      case 'RefType':
      case 'OptionalType':
        throw new Error(`Unsupported schema kind: ${schema.$kind}`);

      default:
        throw new Error(`Unknown schema kind: ${schema.$kind}`);
    }
  }

  /**
   * Insert an entry into the database and return its ID.
   * This is the core method for adding new nodes to the knowledge graph.
   *
   * Each entry must have a `$type` field specifying its type.
   * Optional fields are filled in by the caller.
   */
  insertEntry(entry: InsertEntry): string {
    const id = uuidv4();
    const typeId = this.getTypeId(entry.$type);
    
    // Build the INSERT statement dynamically based on entry fields
    const fields = Object.keys(entry);
    const values = fields.map(field => (entry as any)[field]);
    const placeholders = fields.map(() => '?').join(', ');
    
    const stmt = this.raw.prepare(`
      INSERT INTO ${entry.$type} (${fields.join(', ')})
      VALUES (${placeholders})
    `);
    
    stmt.run(...values);
    return id;
  }

  /**
   * Get the type ID for a given type name.
   * Creates the type if it doesn't exist.
   */
  getTypeId(typeName: string): string {
    const result = this.raw.prepare('SELECT id FROM types WHERE kind = ?').get(typeName) as { id: string } | undefined;
    if (result) {
      return result.id;
    }
    return this.insertEntry({
      $type: 'types',
      kind: typeName,
    });
  }

  /**
   * Insert a batch of entries into the database.
   * Returns the IDs of inserted entries in the same order.
   *
   * Reference resolution:
   * - `{ "$ref": N }` references the N-th entry in the `entries` array
   * - `{ "$id": "uuid" }` references an existing node in the database
   */
  insertEntries(entries: InsertEntry[]): InsertResult {
    const result: InsertResult = {
      ids: [],
      entries: entries,
    };
    
    const entryIndexes = new Map<string, number>();
    
    for (let i = 0; i < entries.length; i++) {
      entryIndexes.set(`$ref:${i}`, i);
    }
    
    for (const entry of entries) {
      const id = this.insertEntry(entry);
      result.ids.push(id);
    }
    
    return result;
  }
}
