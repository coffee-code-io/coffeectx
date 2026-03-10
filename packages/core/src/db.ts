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
        INSERT INTO types_new(id, kind, ref_name, content_key)
          SELECT id, kind, ref_name, content_key FROM types;
        DROP TABLE types;
        ALTER TABLE types_new RENAME TO types;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_types_content_key
          ON types(content_key) WHERE content_key IS NOT NULL;
      `);
      this.raw.pragma('foreign_keys = ON');
    }
  }

  // ── Type upsert ────────────────────────────────────────────────────────────
  //
  // Structural types (ListType, OrType, AndType, MapType) are deduplicated by a
  // content_key — a deterministic fingerprint built from the child type IDs.
  // This prevents duplicate rows from accumulating across repeated sync runs.
  //
  // RefType rows are deduplicated by ref_name.
  // SymbolType / MeaningType are global singletons (at most one row each).

  upsertType(type: Type, cache: Map<Type, string> = new Map()): string {
    const existing = cache.get(type);
    if (existing) return existing;

    // Global singletons
    if (type.kind === 'SymbolType' || type.kind === 'MeaningType') {
      const row = this.raw
        .prepare(`SELECT id FROM types WHERE kind=? LIMIT 1`)
        .get(type.kind) as { id: string } | undefined;
      if (row) { cache.set(type, row.id); return row.id; }
      const id = uuidv4();
      this.raw.prepare(`INSERT INTO types(id, kind) VALUES(?,?)`).run(id, type.kind);
      cache.set(type, id);
      return id;
    }

    // RefType — deduplicated by name
    if (type.kind === 'RefType') {
      const row = this.raw
        .prepare(`SELECT id FROM types WHERE kind='RefType' AND ref_name=?`)
        .get(type.name) as { id: string } | undefined;
      if (row) { cache.set(type, row.id); return row.id; }
      const id = uuidv4();
      this.raw
        .prepare(`INSERT INTO types(id, kind, ref_name) VALUES(?,?,?)`)
        .run(id, 'RefType', type.name);
      cache.set(type, id);
      return id;
    }

    // Structural types — deduplicated by content_key
    if (type.kind === 'ListType') {
      const itemId = this.upsertType(type.itemType, cache);
      const contentKey = `L:{${itemId}}`;
      return this.upsertStructural('ListType', contentKey, cache, type, id => {
        this.raw
          .prepare(`INSERT INTO type_children(type_id, position, child_type_id) VALUES(?,0,?)`)
          .run(id, itemId);
      });
    }

    if (type.kind === 'OrType' || type.kind === 'AndType') {
      const leftId = this.upsertType(type.left, cache);
      const rightId = this.upsertType(type.right, cache);
      const contentKey = `${type.kind}:{${leftId}}:{${rightId}}`;
      return this.upsertStructural(type.kind, contentKey, cache, type, id => {
        this.raw
          .prepare(`INSERT INTO type_children(type_id, position, child_type_id) VALUES(?,0,?)`)
          .run(id, leftId);
        this.raw
          .prepare(`INSERT INTO type_children(type_id, position, child_type_id) VALUES(?,1,?)`)
          .run(id, rightId);
      });
    }

    if (type.kind === 'OptionalType') {
      const innerId = this.upsertType(type.inner, cache);
      const contentKey = `OPT:{${innerId}}`;
      return this.upsertStructural('OptionalType', contentKey, cache, type, id => {
        this.raw
          .prepare(`INSERT INTO type_children(type_id, position, child_type_id) VALUES(?,0,?)`)
          .run(id, innerId);
      });
    }

    if (type.kind === 'MapType') {
      // Resolve all field types first so we can build the content key.
      const fieldIds = Object.fromEntries(
        Object.entries(type.entries).map(([k, v]) => [k, this.upsertType(v, cache)]),
      );
      const contentKey =
        'M:{' +
        Object.entries(fieldIds)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => `${k}=${v}`)
          .join(',') +
        '}';
      return this.upsertStructural('MapType', contentKey, cache, type, id => {
        for (const [key, valId] of Object.entries(fieldIds)) {
          this.raw
            .prepare(`INSERT INTO type_map_entries(type_id, key, value_type_id) VALUES(?,?,?)`)
            .run(id, key, valId);
        }
      });
    }

    throw new Error(`Unknown Type kind: ${(type as Type).kind}`);
  }

  /** Lookup or insert a structural type row by content key. */
  private upsertStructural(
    kind: string,
    contentKey: string,
    cache: Map<Type, string>,
    type: Type,
    insertChildren: (id: string) => void,
  ): string {
    const row = this.raw
      .prepare(`SELECT id FROM types WHERE content_key=?`)
      .get(contentKey) as { id: string } | undefined;
    if (row) { cache.set(type, row.id); return row.id; }
    const id = uuidv4();
    this.raw
      .prepare(`INSERT INTO types(id, kind, content_key) VALUES(?,?,?)`)
      .run(id, kind, contentKey);
    cache.set(type, id);
    insertChildren(id);
    return id;
  }

  /**
   * Remove type rows that are no longer reachable from any named type.
   * Returns the number of deleted rows.
   * Call after bulk sync operations to keep the types table clean.
   */
  gcOrphanedTypes(): number {
    const info = this.raw.prepare(`
      WITH RECURSIVE reachable(id) AS (
        SELECT type_id FROM named_types
        UNION ALL
        SELECT tc.child_type_id
          FROM type_children tc
          INNER JOIN reachable r ON r.id = tc.type_id
        UNION ALL
        SELECT tme.value_type_id
          FROM type_map_entries tme
          INNER JOIN reachable r ON r.id = tme.type_id
      )
      DELETE FROM types WHERE id NOT IN (SELECT id FROM reachable)
    `).run();
    return info.changes;
  }

  /**
   * Load a type, resolving RefType nodes to their targets.
   * The shared cache prevents infinite recursion on circular types.
   */
  loadType(id: string, cache: Map<string, Type> = new Map()): Type {
    return this.loadTypeImpl(id, cache, true);
  }

  /**
   * Load a type WITHOUT resolving RefType nodes.
   * Use this when you need to pass the type back to upsertType — the shallow
   * representation matches the stored content_key so deduplication works correctly.
   */
  loadTypeShallow(id: string, cache: Map<string, Type> = new Map()): Type {
    return this.loadTypeImpl(id, cache, false);
  }

  private loadTypeImpl(id: string, cache: Map<string, Type>, resolveRefs: boolean): Type {
    const existing = cache.get(id);
    if (existing) return existing;

    const row = this.raw.prepare(`SELECT kind, ref_name FROM types WHERE id=?`).get(id) as
      | { kind: string; ref_name: string | null }
      | undefined;
    if (!row) throw new Error(`Type not found: ${id}`);
    const kind = row.kind as Type['kind'];

    if (kind === 'SymbolType') {
      const t: Type = { kind: 'SymbolType' };
      cache.set(id, t);
      return t;
    }
    if (kind === 'MeaningType') {
      const t: Type = { kind: 'MeaningType' };
      cache.set(id, t);
      return t;
    }

    if (kind === 'RefType') {
      const refName = row.ref_name;
      if (!refName) throw new Error(`RefType row ${id} is missing ref_name`);
      if (!resolveRefs) {
        const t: Type = { kind: 'RefType', name: refName };
        cache.set(id, t);
        return t;
      }
      // Resolve: follow the pointer to the named type's actual structure.
      const namedEntry = this.loadNamedType(refName);
      if (!namedEntry) throw new Error(`RefType target named type "${refName}" not found`);
      const resolved = this.loadTypeImpl(namedEntry.typeId, cache, resolveRefs);
      cache.set(id, resolved);
      return resolved;
    }

    if (kind === 'ListType') {
      const result: Type = { kind: 'ListType', itemType: { kind: 'SymbolType' } };
      cache.set(id, result);
      const child = this.raw
        .prepare(`SELECT child_type_id FROM type_children WHERE type_id=? AND position=0`)
        .get(id) as { child_type_id: string };
      (result as Extract<Type, { kind: 'ListType' }>).itemType = this.loadTypeImpl(child.child_type_id, cache, resolveRefs);
      return result;
    }

    if (kind === 'OptionalType') {
      const result: Type = { kind: 'OptionalType', inner: { kind: 'SymbolType' } };
      cache.set(id, result);
      const child = this.raw
        .prepare(`SELECT child_type_id FROM type_children WHERE type_id=? AND position=0`)
        .get(id) as { child_type_id: string };
      (result as Extract<Type, { kind: 'OptionalType' }>).inner = this.loadTypeImpl(child.child_type_id, cache, resolveRefs);
      return result;
    }

    if (kind === 'OrType' || kind === 'AndType') {
      const result: Type =
        kind === 'OrType'
          ? { kind: 'OrType', left: { kind: 'SymbolType' }, right: { kind: 'SymbolType' } }
          : { kind: 'AndType', left: { kind: 'SymbolType' }, right: { kind: 'SymbolType' } };
      cache.set(id, result);
      const children = this.raw
        .prepare(`SELECT child_type_id FROM type_children WHERE type_id=? ORDER BY position`)
        .all(id) as { child_type_id: string }[];
      const left = this.loadTypeImpl(children[0]!.child_type_id, cache, resolveRefs);
      const right = this.loadTypeImpl(children[1]!.child_type_id, cache, resolveRefs);
      if (kind === 'OrType') {
        (result as Extract<Type, { kind: 'OrType' }>).left = left;
        (result as Extract<Type, { kind: 'OrType' }>).right = right;
      } else {
        (result as Extract<Type, { kind: 'AndType' }>).left = left;
        (result as Extract<Type, { kind: 'AndType' }>).right = right;
      }
      return result;
    }

    if (kind === 'MapType') {
      const result: Extract<Type, { kind: 'MapType' }> = { kind: 'MapType', entries: {} };
      cache.set(id, result);
      const entries = this.raw
        .prepare(`SELECT key, value_type_id FROM type_map_entries WHERE type_id=?`)
        .all(id) as { key: string; value_type_id: string }[];
      for (const { key, value_type_id } of entries) {
        result.entries[key] = this.loadTypeImpl(value_type_id, cache, resolveRefs);
      }
      return result;
    }

    throw new Error(`Unknown type kind: ${kind}`);
  }

  // ── Node insertion ─────────────────────────────────────────────────────────
  // Pre-computes all embeddings before writing (better-sqlite3 is synchronous).

  async insertNode(node: Node): Promise<string> {


    // 1. Pre-compute all embeddings in the tree
    const embeds = new Map<string, Float32Array>(); // placeholder key → vec
    await this.collectEmbeds(node, embeds);

    // 2. Write everything in a single synchronous transaction
    let rootId!: string;
    const txn = this.raw.transaction(() => {
      rootId = this.writeNode(node, embeds);
    });
    txn();
    return rootId;
  }

  private async collectEmbeds(node: Node, out: Map<string, Float32Array>): Promise<void> {
    if (node.kind === 'atom' && node.atom.kind === 'meaning') {
      const { text, vec } = node.atom.value;
      // Use the provided vec if already the right size; otherwise embed
      const key = text;
      if (!out.has(key)) {
        out.set(key, vec.length === this.dims ? vec : await this.embed(text));
      }
    } else if (node.kind === 'list') {
      for (const item of node.items) await this.collectEmbeds(item, out);
    } else if (node.kind === 'map') {
      for (const val of Object.values(node.entries)) await this.collectEmbeds(val, out);
    }
  }

  private writeNode(node: Node, embeds: Map<string, Float32Array>): string {
    const id = uuidv4();

    if (node.kind === 'atom') {
      return this.writeAtom(node.atom, embeds);
    }

    if (node.kind === 'list') {
      this.raw.prepare(`INSERT INTO nodes(id, kind) VALUES(?,?)`).run(id, 'list');
      for (let i = 0; i < node.items.length; i++) {
        const itemId = this.writeNode(node.items[i]!, embeds);
        this.raw
          .prepare(`INSERT INTO list_items(list_id, position, item_id) VALUES(?,?,?)`)
          .run(id, i, itemId);
      }
      return id;
    }

    if (node.kind === 'map') {
      const typeId = this.upsertType(node.type);
      this.raw
        .prepare(`INSERT INTO nodes(id, kind, type_id) VALUES(?,?,?)`)
        .run(id, 'map', typeId);
      for (const [key, val] of Object.entries(node.entries)) {
        const valId = this.writeNode(val, embeds);
        this.raw
          .prepare(`INSERT INTO map_entries(map_id, key, value_id) VALUES(?,?,?)`)
          .run(id, key, valId);
      }
      return id;
    }

    throw new Error(`Unknown node kind`);
  }

  private writeAtom(atom: Atom, embeds: Map<string, Float32Array>): string {
    const id = uuidv4();

    if (atom.kind === 'symbol') {
      this.raw
        .prepare(`INSERT INTO nodes(id, kind, symbol_value) VALUES(?,?,?)`)
        .run(id, 'symbol', atom.value);
      return id;
    }

    if (atom.kind === 'meaning') {
      this.raw
        .prepare(`INSERT INTO nodes(id, kind, meaning_text) VALUES(?,?,?)`)
        .run(id, 'meaning', atom.value.text);
      const vec = embeds.get(atom.value.text) ?? new Float32Array(this.dims);
      this.raw
        .prepare(`INSERT INTO meaning_vecs(node_id, embedding) VALUES(?,?)`)
        .run(id, vec);
      return id;
    }

    throw new Error(`Unknown atom kind`);
  }

  // ── Unified typed upsert ───────────────────────────────────────────────────
  //
  // Handles both new insertions and patches of existing nodes in one batch.
  //
  // For entries WITHOUT id (insert):
  //   - All required (non-optional) fields must be present.
  //   - Two-phase write: INSERT shell first so $ref can point to it, then fields.
  //   - Use { "$ref": N } in data to reference the N-th entry (0-based).
  //
  // For entries WITH id (patch):
  //   - The node must exist and be a MapType matching the given type.
  //   - Only fields absent on the node are added; existing keys are skipped.
  //   - Partial data is accepted — required-field check is relaxed.

  async insertEntries(entries: InsertEntry[]): Promise<InsertResult> {
    log(`insertEntries: ${entries.length} entries`);

    const errors: InsertResult['errors'] = [];
    const skippedKeys: string[][] = entries.map(() => []);

    // ── Phase 1: validate types ─────────────────────────────────────────────
    const typeInfos: Array<{ typeId: string; schema: Extract<Type, { kind: 'MapType' }> } | null> = [];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;

      // For patch entries verify the existing node exists and has a compatible type.
      if (entry.id) {
        // Reject empty patch — there's nothing to do.
        if (Object.keys(entry.data).length === 0) {
          errors.push({
            index: i,
            path: '',
            message: `Patch entry[${i}] has no fields to add. Provide actual field values in "data".`,
          });
          typeInfos.push(null);
          continue;
        }

        const row = this.raw
          .prepare(`SELECT kind, type_id FROM nodes WHERE id=?`)
          .get(entry.id) as { kind: string; type_id: string | null } | undefined;
        if (!row) {
          errors.push({ index: i, path: '', message: `Node not found: "${entry.id}"` });
          typeInfos.push(null);
          continue;
        }
        if (row.kind !== 'map') {
          errors.push({ index: i, path: '', message: `Node "${entry.id}" is not a map (got ${row.kind})` });
          typeInfos.push(null);
          continue;
        }
        if (!row.type_id) {
          errors.push({ index: i, path: '', message: `Node "${entry.id}" has no type` });
          typeInfos.push(null);
          continue;
        }

        // Verify the caller's stated type matches the node's actual named type.
        const actualNamed = this.raw
          .prepare(`SELECT name FROM named_types WHERE type_id=?`)
          .get(row.type_id) as { name: string } | undefined;
        if (actualNamed && actualNamed.name !== entry.type) {
          errors.push({
            index: i,
            path: '',
            message: `Type mismatch for node "${entry.id}": node is type "${actualNamed.name}", but entry specifies type "${entry.type}". Use type "${actualNamed.name}" to patch this node.`,
          });
          typeInfos.push(null);
          continue;
        }

        const schema = this.loadTypeShallow(row.type_id);
        if (schema.kind !== 'MapType') {
          errors.push({ index: i, path: '', message: `Node "${entry.id}" type is not MapType` });
          typeInfos.push(null);
          continue;
        }
        typeInfos.push({ typeId: row.type_id, schema });
        continue;
      }

      // For new entries look up the named type.
      const named = this.loadNamedType(entry.type);
      if (!named) {
        errors.push({ index: i, path: '', message: `Unknown named type: "${entry.type}"` });
        typeInfos.push(null);
        continue;
      }
      const schema = this.loadTypeShallow(named.typeId);
      if (schema.kind !== 'MapType') {
        errors.push({ index: i, path: '', message: `Type "${entry.type}" is ${schema.kind}, expected MapType` });
        typeInfos.push(null);
        continue;
      }
      typeInfos.push({ typeId: named.typeId, schema });
    }

    // ── Phase 2: allocate IDs ───────────────────────────────────────────────
    // Patch entries reuse their existing id; new entries get a fresh uuid.
    const allocatedIds: (string | null)[] = entries.map((e, i) =>
      typeInfos[i] ? (e.id ?? uuidv4()) : null,
    );

    // ── Phase 2.5: validate required fields (insert-only) ───────────────────
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      if (entry.id) continue; // patches accept partial data
      const ti = typeInfos[i];
      if (!ti) continue;
      const missing: string[] = [];
      for (const [key, fieldType] of Object.entries(ti.schema.entries)) {
        if (fieldType.kind !== 'OptionalType' && entry.data[key] == null) missing.push(key);
      }
      if (missing.length > 0) {
        errors.push({
          index: i,
          path: '',
          message: `Entry[${i}] type "${entry.type}" is missing required fields: ${missing.join(', ')}. Available fields: ${Object.keys(ti.schema.entries).join(', ')}`,
        });
        allocatedIds[i] = null;
      }
    }

    // ── Phase 2.7: for patches, load existing keys to avoid re-embedding ────
    const existingKeysPerEntry = new Map<number, Set<string>>();
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;
      if (!entry.id || !allocatedIds[i]) continue;
      const rows = this.raw
        .prepare(`SELECT key FROM map_entries WHERE map_id=?`)
        .all(entry.id) as { key: string }[];
      existingKeysPerEntry.set(i, new Set(rows.map(r => r.key)));
    }

    // ── Phase 3: collect meaning texts for embedding ────────────────────────
    const meaningTexts = new Set<string>();
    for (let i = 0; i < entries.length; i++) {
      const ti = typeInfos[i];
      if (!ti || !allocatedIds[i]) continue;
      const entry = entries[i]!;
      const existingKeys = existingKeysPerEntry.get(i);

      if (existingKeys) {
        // Patch: only collect meanings for keys we'll actually add.
        for (const [key, fieldType] of Object.entries(ti.schema.entries)) {
          if (existingKeys.has(key)) continue;
          if (entry.data[key] != null) this.collectEntryMeanings(entry.data[key], fieldType, meaningTexts);
        }
      } else {
        this.collectEntryMeanings(entry.data, ti.schema, meaningTexts);
      }
    }

    log(`insertEntries: embedding ${meaningTexts.size} texts`);
    const embedMap = new Map<string, Float32Array>();
    for (const text of meaningTexts) embedMap.set(text, await this.embed(text));

    // ── Phase 4: write in a single transaction ──────────────────────────────
    const txn = this.raw.transaction(() => {
      // Insert shells for new entries first so $ref can resolve them.
      for (let i = 0; i < entries.length; i++) {
        const ti = typeInfos[i];
        const id = allocatedIds[i];
        if (!ti || !id || entries[i]!.id) continue; // skip patches and failed entries
        this.raw.prepare(`INSERT INTO nodes(id, kind, type_id) VALUES(?,?,?)`).run(id, 'map', ti.typeId);
      }

      // Write field values for all entries.
      for (let i = 0; i < entries.length; i++) {
        const ti = typeInfos[i];
        const id = allocatedIds[i];
        if (!ti || !id) continue;

        const entry = entries[i]!;
        const existingKeys = existingKeysPerEntry.get(i) ?? null;

        for (const [key, fieldType] of Object.entries(ti.schema.entries)) {
          const value = entry.data[key];
          if (value == null) continue;

          // Patch mode: skip keys that already exist on the node.
          if (existingKeys) {
            if (existingKeys.has(key)) {
              skippedKeys[i]!.push(key);
              continue;
            }
          }

          let valueId: string;
          try {
            valueId = this.buildEntryNode(value, fieldType, allocatedIds, embedMap, `[${i}].${key}`);
          } catch (err) {
            errors.push({ index: i, path: key, message: (err as Error).message });
            continue;
          }
          this.raw.prepare(`INSERT INTO map_entries(map_id, key, value_id) VALUES(?,?,?)`).run(id, key, valueId);
        }
      }
    });
    txn();

    log(`insertEntries: done, ${errors.length} errors`);
    return { ids: allocatedIds, errors, skippedKeys };
  }

  /**
   * Recursively collect meaning strings from entry data following the shallow
   * type schema, so embeddings can be pre-computed before the transaction.
   */
  private collectEntryMeanings(value: unknown, type: Type, out: Set<string>): void {
    if (value == null) return;
    if (typeof value === 'object' && '$ref' in (value as object)) return;

    if (type.kind === 'RefType') {
      const named = this.loadNamedType(type.name);
      if (!named) return;
      this.collectEntryMeanings(value, this.loadTypeShallow(named.typeId), out);
      return;
    }
    if (type.kind === 'OptionalType') {
      this.collectEntryMeanings(value, type.inner, out);
      return;
    }
    if (type.kind === 'MeaningType' && typeof value === 'string') {
      out.add(value);
      return;
    }
    if (type.kind === 'MapType' && typeof value === 'object' && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>;
      for (const [key, fieldType] of Object.entries(type.entries)) {
        if (obj[key] != null) this.collectEntryMeanings(obj[key], fieldType, out);
      }
      return;
    }
    if (type.kind === 'ListType' && Array.isArray(value)) {
      for (const item of value) this.collectEntryMeanings(item, type.itemType, out);
    }
  }

  /**
   * Build (insert) a node for a single field value given its shallow schema type.
   * Called inside the transaction; must be synchronous.
   *
   * `{ "$ref": N }` resolves to the pre-allocated ID of the N-th top-level entry.
   */
  private buildEntryNode(
    value: unknown,
    type: Type,
    allocatedIds: (string | null)[],
    embedMap: Map<string, Float32Array>,
    path: string,
  ): string {
    // $ref — circular/forward reference to a top-level entry
    if (value !== null && typeof value === 'object' && '$ref' in (value as object)) {
      const idx = (value as { $ref: number }).$ref;
      const id = allocatedIds[idx];
      if (id == null)
        throw new Error(`$ref[${idx}]: entry does not exist or failed type validation`);
      return id;
    }

    // OptionalType — unwrap and delegate; empty/null already filtered at call sites
    if (type.kind === 'OptionalType') {
      return this.buildEntryNode(value, type.inner, allocatedIds, embedMap, path);
    }

    // RefType — inline map/list whose schema is defined under a named type
    if (type.kind === 'RefType') {
      const named = this.loadNamedType(type.name);
      if (!named) throw new Error(`${path}: RefType target "${type.name}" not found`);
      return this.buildEntryNode(value, this.loadTypeShallow(named.typeId), allocatedIds, embedMap, path);
    }

    if (type.kind === 'SymbolType') {
      if (typeof value !== 'string')
        throw new Error(`${path}: expected string for SymbolType, got ${typeof value}`);
      const id = uuidv4();
      this.raw.prepare(`INSERT INTO nodes(id, kind, symbol_value) VALUES(?,?,?)`).run(id, 'symbol', value);
      return id;
    }

    if (type.kind === 'MeaningType') {
      if (typeof value !== 'string')
        throw new Error(`${path}: expected string for MeaningType, got ${typeof value}`);
      const id = uuidv4();
      this.raw.prepare(`INSERT INTO nodes(id, kind, meaning_text) VALUES(?,?,?)`).run(id, 'meaning', value);
      const vec = embedMap.get(value) ?? new Float32Array(this.dims);
      this.raw.prepare(`INSERT INTO meaning_vecs(node_id, embedding) VALUES(?,?)`).run(id, vec);
      return id;
    }

    if (type.kind === 'ListType') {
      if (!Array.isArray(value))
        throw new Error(`${path}: expected array for ListType, got ${typeof value}`);
      const id = uuidv4();
      this.raw.prepare(`INSERT INTO nodes(id, kind) VALUES(?,?)`).run(id, 'list');
      for (let i = 0; i < value.length; i++) {
        const itemId = this.buildEntryNode(value[i], type.itemType, allocatedIds, embedMap, `${path}[${i}]`);
        this.raw.prepare(`INSERT INTO list_items(list_id, position, item_id) VALUES(?,?,?)`).run(id, i, itemId);
      }
      return id;
    }

    if (type.kind === 'MapType') {
      if (typeof value !== 'object' || value === null || Array.isArray(value))
        throw new Error(`${path}: expected object for MapType, got ${typeof value}`);
      const obj = value as Record<string, unknown>;
      // upsertType on a shallow MapType finds the existing DB row via content_key.
      const typeId = this.upsertType(type);
      const id = uuidv4();
      this.raw.prepare(`INSERT INTO nodes(id, kind, type_id) VALUES(?,?,?)`).run(id, 'map', typeId);
      for (const [key, fieldType] of Object.entries(type.entries)) {
        if (obj[key] == null) continue;
        const valId = this.buildEntryNode(obj[key], fieldType, allocatedIds, embedMap, `${path}.${key}`);
        this.raw.prepare(`INSERT INTO map_entries(map_id, key, value_id) VALUES(?,?,?)`).run(id, key, valId);
      }
      return id;
    }

    throw new Error(`${path}: unsupported type kind "${type.kind}"`);
  }

  // ── Node loading ───────────────────────────────────────────────────────────

  loadNode(id: string): Node {
    const row = this.raw
      .prepare(
        `SELECT id, kind,
                symbol_value  AS symbolValue,
                meaning_text  AS meaningText,
                type_id       AS typeId
         FROM nodes WHERE id=?`,
      )
      .get(id) as StoredNode | undefined;
    if (!row) throw new Error(`Node not found: ${id}`);

    if (row.kind === 'symbol') {
      return { kind: 'atom', atom: { kind: 'symbol', value: row.symbolValue! } };
    }

    if (row.kind === 'meaning') {
      const vecRow = this.raw
        .prepare(`SELECT embedding FROM meaning_vecs WHERE node_id=?`)
        .get(id) as { embedding: Buffer } | undefined;
      const vec = vecRow ? new Float32Array(vecRow.embedding.buffer) : new Float32Array(this.dims);
      return { kind: 'atom', atom: { kind: 'meaning', value: { text: row.meaningText!, vec } } };
    }

    if (row.kind === 'list') {
      const items = this.raw
        .prepare(`SELECT item_id FROM list_items WHERE list_id=? ORDER BY position`)
        .all(id) as { item_id: string }[];
      return { kind: 'list', items: items.map(r => this.loadNode(r.item_id)) };
    }

    if (row.kind === 'map') {
      const entries = this.raw
        .prepare(`SELECT key, value_id FROM map_entries WHERE map_id=?`)
        .all(id) as { key: string; value_id: string }[];
      const type = this.loadType(row.typeId!);
      const result: Record<Sym, Node> = {};
      for (const { key, value_id } of entries) result[key] = this.loadNode(value_id);
      return { kind: 'map', entries: result, type };
    }

    throw new Error(`Unknown node kind: ${row.kind}`);
  }

  /**
   * Load a node tree with configurable recursion depth and cycle detection.
   *
   * @param id       - Root node ID.
   * @param depth    - How many container (map/list) levels to expand. Atoms are
   *                   always loaded in full regardless of depth. Default: 10.
   * @param ancestors - IDs of nodes currently on the load path (cycle guard).
   *                   Leave unset on the initial call.
   *
   * Returns `{ kind: 'ref', id }` when `depth` is exhausted on a container,
   * and `{ kind: 'cycle', id }` when a node ID is detected in the ancestor path.
   */
  loadNodeDeep(id: string, depth = 10, ancestors: ReadonlySet<string> = new Set()): DeepNode {
    if (ancestors.has(id)) return { kind: 'cycle', id };

    const row = this.raw
      .prepare(
        `SELECT id, kind,
                symbol_value  AS symbolValue,
                meaning_text  AS meaningText,
                type_id       AS typeId
         FROM nodes WHERE id=?`,
      )
      .get(id) as StoredNode | undefined;
    if (!row) throw new Error(`Node not found: ${id}`);

    if (row.kind === 'symbol') {
      return { kind: 'atom', atom: { kind: 'symbol', value: row.symbolValue! } };
    }

    if (row.kind === 'meaning') {
      const vecRow = this.raw
        .prepare(`SELECT embedding FROM meaning_vecs WHERE node_id=?`)
        .get(id) as { embedding: Buffer } | undefined;
      const vec = vecRow ? new Float32Array(vecRow.embedding.buffer) : new Float32Array(this.dims);
      return { kind: 'atom', atom: { kind: 'meaning', value: { text: row.meaningText!, vec } } };
    }

    // Containers respect the depth limit.
    if (depth === 0) return { kind: 'ref', id };

    const childAncestors = new Set(ancestors);
    childAncestors.add(id);

    if (row.kind === 'list') {
      const items = this.raw
        .prepare(`SELECT item_id FROM list_items WHERE list_id=? ORDER BY position`)
        .all(id) as { item_id: string }[];
      return {
        kind: 'list',
        items: items.map(r => this.loadNodeDeep(r.item_id, depth - 1, childAncestors)),
      };
    }

    if (row.kind === 'map') {
      const entries = this.raw
        .prepare(`SELECT key, value_id FROM map_entries WHERE map_id=?`)
        .all(id) as { key: string; value_id: string }[];
      const type = this.loadType(row.typeId!);
      const namedRow = this.raw
        .prepare(`SELECT name FROM named_types WHERE type_id=?`)
        .get(row.typeId!) as { name: string } | undefined;
      const result: Record<Sym, DeepNode> = {};
      for (const { key, value_id } of entries) {
        result[key] = this.loadNodeDeep(value_id, depth - 1, childAncestors);
      }
      return { kind: 'map', entries: result, type, typeName: namedRow?.name };
    }

    throw new Error(`Unknown node kind: ${row.kind}`);
  }

  // ── QueryDb interface ──────────────────────────────────────────────────────

  queryById(id: string): string[] {
    const row = this.raw.prepare(`SELECT id FROM nodes WHERE id=?`).get(id) as { id: string } | undefined;
    return row ? [row.id] : [];
  }

  querySymbolExact(value: string): string[] {
    const rows = this.raw
      .prepare(`SELECT id FROM nodes WHERE kind='symbol' AND symbol_value=?`)
      .all(value) as { id: string }[];
    return rows.map(r => r.id);
  }

  querySymbolRegex(pattern: string): string[] {
    const rows = this.raw
      .prepare(`SELECT id FROM nodes WHERE kind='symbol' AND regexp(?, symbol_value)`)
      .all(pattern) as { id: string }[];
    return rows.map(r => r.id);
  }

  async queryMeaning(text: string, limit: number): Promise<string[]> {
    const vec = await this.embed(text);
    const rows = this.raw
      .prepare(
        `SELECT node_id FROM meaning_vecs WHERE embedding MATCH ? AND k=? ORDER BY distance`,
      )
      .all(vec, limit) as { node_id: string }[];
    return rows.map(r => r.node_id);
  }

  queryByNamedType(names: string[]): string[] {
    if (names.length === 0) return [];
    const placeholders = names.map(() => '?').join(',');
    const rows = this.raw
      .prepare(
        `SELECT n.id FROM nodes n
         JOIN named_types nt ON n.type_id = nt.type_id
         WHERE nt.name IN (${placeholders})`,
      )
      .all(...names) as { id: string }[];
    return rows.map(r => r.id);
  }

  queryMapsByField(key: string, valueIds: string[]): string[] {
    if (valueIds.length === 0) return [];
    const placeholders = valueIds.map(() => '?').join(',');
    const rows = this.raw
      .prepare(
        `SELECT map_id FROM map_entries WHERE key=? AND value_id IN (${placeholders})`,
      )
      .all(key, ...valueIds) as { map_id: string }[];
    return rows.map(r => r.map_id);
  }

  queryListsByItem(itemIds: string[]): string[] {
    if (itemIds.length === 0) return [];
    const placeholders = itemIds.map(() => '?').join(',');
    const rows = this.raw
      .prepare(`SELECT list_id FROM list_items WHERE item_id IN (${placeholders})`)
      .all(...itemIds) as { list_id: string }[];
    return rows.map(r => r.list_id);
  }

  /**
   * Find the nearest ancestor of nodeId that is a named-type map node.
   * Returns { id, typeName } or null if none is found within 20 hops.
   */
  findNamedParent(nodeId: string): { id: string; typeName: string } | null {
    const row = this.raw.prepare(`
      WITH RECURSIVE container(id, depth) AS (
        SELECT map_id AS id, 1 AS depth FROM map_entries WHERE value_id = ?
        UNION ALL
        SELECT list_id AS id, 1 AS depth FROM list_items WHERE item_id = ?
        UNION ALL
        SELECT me.map_id, c.depth + 1 FROM map_entries me JOIN container c ON me.value_id = c.id WHERE c.depth < 20
        UNION ALL
        SELECT li.list_id, c.depth + 1 FROM list_items li JOIN container c ON li.item_id = c.id WHERE c.depth < 20
      )
      SELECT c.id, nt.name AS typeName FROM container c
      JOIN nodes n ON n.id = c.id
      JOIN named_types nt ON nt.type_id = n.type_id
      ORDER BY c.depth ASC LIMIT 1
    `).get(nodeId, nodeId) as { id: string; typeName: string } | undefined;
    return row ?? null;
  }

  // ── Vector search (with full node loading) ─────────────────────────────────

  async searchByText(query: string, limit = 10, offset = 0): Promise<SearchResult[]> {
    const vec = await this.embed(query);
    const rows = this.raw
      .prepare(
        `SELECT node_id, distance FROM meaning_vecs
         WHERE embedding MATCH ? AND k=? ORDER BY distance`,
      )
      .all(vec, limit + offset) as { node_id: string; distance: number }[];
    return rows.slice(offset).map(r => ({
      nodeId: r.node_id,
      node: this.loadNode(r.node_id),
      distance: r.distance,
    }));
  }

  listByKind(kind: StoredNode['kind'], limit = 100, offset = 0): Node[] {
    const rows = this.raw
      .prepare(`SELECT id FROM nodes WHERE kind=? LIMIT ? OFFSET ?`)
      .all(kind, limit, offset) as { id: string }[];
    return rows.map(r => this.loadNode(r.id));
  }

  // ── Named types ────────────────────────────────────────────────────────────

  upsertNamedType(
    name: string,
    typeId: string,
    source: 'builtin' | 'user' = 'user',
    description?: string,
  ): void {
    this.raw
      .prepare(
        `INSERT INTO named_types(name, type_id, description, source, updated_at)
         VALUES(?, ?, ?, ?, datetime('now'))
         ON CONFLICT(name) DO UPDATE
           SET type_id=excluded.type_id,
               description=excluded.description,
               source=excluded.source,
               updated_at=excluded.updated_at`,
      )
      .run(name, typeId, description ?? null, source);
  }

  loadNamedType(name: string): { typeId: string; description: string | null; source: string } | null {
    const row = this.raw
      .prepare(`SELECT type_id, description, source FROM named_types WHERE name=?`)
      .get(name) as { type_id: string; description: string | null; source: string } | undefined;
    return row ? { typeId: row.type_id, description: row.description, source: row.source } : null;
  }

  listNamedTypes(): { name: string; typeId: string; description: string | null; source: string }[] {
    return (
      this.raw
        .prepare(`SELECT name, type_id, description, source FROM named_types ORDER BY source, name`)
        .all() as { name: string; type_id: string; description: string | null; source: string }[]
    ).map(r => ({ name: r.name, typeId: r.type_id, description: r.description, source: r.source }));
  }

  // ── Skills ─────────────────────────────────────────────────────────────────

  upsertSkill(
    name: string,
    prompt: string,
    source: 'builtin' | 'user' = 'user',
    description?: string,
    typeNames: string[] = [],
  ): void {
    const txn = this.raw.transaction(() => {
      this.raw
        .prepare(
          `INSERT INTO skills(name, description, prompt, source, updated_at)
           VALUES(?, ?, ?, ?, datetime('now'))
           ON CONFLICT(name) DO UPDATE
             SET description=excluded.description,
                 prompt=excluded.prompt,
                 source=excluded.source,
                 updated_at=excluded.updated_at`,
        )
        .run(name, description ?? null, prompt, source);

      this.raw.prepare(`DELETE FROM skill_types WHERE skill_name=?`).run(name);
      for (let i = 0; i < typeNames.length; i++) {
        this.raw
          .prepare(`INSERT INTO skill_types(skill_name, type_name, position) VALUES(?,?,?)`)
          .run(name, typeNames[i], i);
      }
    });
    txn();
  }

  getSkill(name: string): { name: string; description: string | null; prompt: string; source: string; types: string[] } | null {
    const row = this.raw
      .prepare(`SELECT name, description, prompt, source FROM skills WHERE name=?`)
      .get(name) as { name: string; description: string | null; prompt: string; source: string } | undefined;
    if (!row) return null;

    const types = (
      this.raw
        .prepare(`SELECT type_name FROM skill_types WHERE skill_name=? ORDER BY position`)
        .all(name) as { type_name: string }[]
    ).map(r => r.type_name);

    return { ...row, types };
  }

  listSkills(): { name: string; description: string | null; source: string; types: string[] }[] {
    const rows = this.raw
      .prepare(`SELECT name, description, source FROM skills ORDER BY source, name`)
      .all() as { name: string; description: string | null; source: string }[];

    return rows.map(r => {
      const types = (
        this.raw
          .prepare(`SELECT type_name FROM skill_types WHERE skill_name=? ORDER BY position`)
          .all(r.name) as { type_name: string }[]
      ).map(t => t.type_name);
      return { ...r, types };
    });
  }

  close(): void {
    this.raw.close();
  }
}
