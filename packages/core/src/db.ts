import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { v4 as uuidv4 } from 'uuid';
import { SCHEMA_DDL, makeVecTableDDL } from './schema.js';
import type { Node, Type, Atom, Sym, EmbedFn, SearchResult, StoredNode, DeepNode, InsertEntry, InsertResult } from './types.js';
import type { QueryDb } from './query.js';
import { populateNodeRefsFor, rebuildNodeRefs } from './nodeRefs.js';

import { log } from './logger.js';

export interface DbOptions {
  path: string;
  embed: EmbedFn;
  /** Embedding dimension. Must match the model's output size. Defaults to 1536. */
  dimensions?: number;
}

/**
 * Fired after node lifecycle commits — root insertions (`insertNode` /
 * `insertEntries`) and explicit state-changes (`setNodeState`).
 *
 * `kind: 'insert'`        → ids/typeNames carry one or more new root nodes.
 *                           `state` is the post-insert state (the type's
 *                           first state by default).
 * `kind: 'state-change'`  → ids is a single node moving from `fromState` to
 *                           `state`. typeNames is that node's named type.
 */
export interface NodeEvent {
  kind: 'insert' | 'state-change';
  ids: string[];
  typeNames: string[];
  /** Target state after the event. Always set for state-change; for
   * inserts only set when the type declares a state machine. */
  state?: string | null;
  /** Previous state. Only set for state-change events. */
  fromState?: string | null;
}

/** @deprecated Kept as an alias while call sites migrate. Use NodeEvent. */
export type InsertEvent = NodeEvent;

export type NodeEventListener = (event: NodeEvent) => void;
/** @deprecated Use NodeEventListener. */
export type InsertListener = NodeEventListener;

export type JobStatus = 'idle' | 'running' | 'disabled';
export type JobResult = 'ok' | 'error' | 'cancelled';
export type JobTriggerKind = 'timer' | 'onTypeInsert' | 'onNodeState' | 'cron' | 'manual' | 'startup';

export interface JobRow {
  name: string;
  description: string | null;
  enabled: boolean;
  status: JobStatus;
  currentRunId: number | null;
  lastStartedAt: string | null;
  lastEndedAt: string | null;
  lastResult: JobResult | null;
  lastError: string | null;
  lastMessage: string | null;
  lastMetrics: Record<string, number> | null;
  triggerPending: boolean;
  state: unknown | null;
}

export interface JobRunRow {
  id: number;
  jobName: string;
  triggerKind: JobTriggerKind;
  startedAt: string;
  endedAt: string | null;
  result: JobResult | null;
  message: string | null;
  error: string | null;
  metrics: Record<string, number> | null;
}

export class Db implements QueryDb {
  private readonly raw: Database.Database;
  private readonly embed: EmbedFn;
  readonly dims: number;
  private readonly nodeEventListeners = new Set<NodeEventListener>();

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
    // Drop the old DB-resident skills tables. Skills are now filesystem-only
    // (loaded from `~/.coffeecode/skills/` at startup by `loadSkillsFromDir`),
    // so these rows are dead weight. INDEX drops first, then child table,
    // then parent — even though FK ON DELETE CASCADE handles row cleanup,
    // DROP TABLE order still matters when FKs are enforced.
    try { this.raw.exec(`DROP INDEX IF EXISTS idx_skill_types_skill`); } catch { /* ok */ }
    try { this.raw.exec(`DROP TABLE IF EXISTS skill_types`); } catch { /* ok */ }
    try { this.raw.exec(`DROP TABLE IF EXISTS skills`); } catch { /* ok */ }

    // named_types.description (pre-skills schema)
    try { this.raw.exec(`ALTER TABLE named_types ADD COLUMN description TEXT`); } catch { /* ok */ }

    // nodes.state — per-node state machine slot. NULL means the node's type
    // declares no state machine (default `[ready]`, single final state).
    try { this.raw.exec(`ALTER TABLE nodes ADD COLUMN state TEXT`); } catch { /* ok */ }

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
            'SymbolType','MeaningType','ListType','OrType','MapType','RefType','OptionalType'
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
            'SymbolType','MeaningType','ListType','OrType','MapType','RefType','OptionalType'
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

    // One-time purge of empty-meaning rows from the vector index. Earlier
    // versions of insertNode/buildEntryNode wrote a zero vector for every
    // MeaningType field, even when the text was empty — those rows pollute
    // search results since they all sit at the same arbitrary distance.
    try {
      const info = this.raw.prepare(`
        DELETE FROM meaning_vecs WHERE node_id IN (
          SELECT id FROM nodes WHERE kind='meaning'
            AND (meaning_text IS NULL OR meaning_text='' OR TRIM(meaning_text)='')
        )
      `).run();
      if (info.changes > 0) {
        log(`db.migrate: purged ${info.changes} empty-meaning vec rows`);
      }
    } catch (err) {
      log(`db.migrate: empty-meaning purge failed: ${(err as Error).message}`);
    }

    // Backfill node_refs once if the table is empty but named-type nodes exist.
    try {
      const hasRefs = this.raw.prepare(`SELECT 1 AS x FROM node_refs LIMIT 1`).get();
      if (!hasRefs) {
        const hasNamed = this.raw
          .prepare(
            `SELECT 1 AS x FROM nodes n JOIN named_types nt ON nt.type_id = n.type_id LIMIT 1`,
          )
          .get();
        if (hasNamed) {
          log(`db.migrate: backfilling node_refs`);
          const t0 = Date.now();
          const { rows } = rebuildNodeRefs(this.raw);
          log(`db.migrate: backfilled node_refs: ${rows} rows in ${Date.now() - t0}ms`);
        }
      }
    } catch (err) {
      log(`db.migrate: node_refs backfill failed: ${(err as Error).message}`);
    }

    // Drop the renamed `logs` job row — the registry now exposes it as
    // `claude` instead, and a stale row would keep showing up in `job list`.
    try {
      const info = this.raw.prepare(`DELETE FROM jobs WHERE name='logs'`).run();
      if (info.changes > 0) log(`db.migrate: dropped orphan 'logs' job row`);
    } catch { /* table may not exist yet */ }

    // Remove obsolete named_types after the directory-schema flatten. The
    // type definitions are gone from code.yaml/directory.yaml; their nodes
    // (if any) are wiped by the manual purge script that accompanies the
    // refactor — here we just clear the named_types index entry so
    // sync-types doesn't trip over them.
    try {
      const info = this.raw
        .prepare(`DELETE FROM named_types WHERE name IN ('File','Folder','Location','Span')`)
        .run();
      if (info.changes > 0) log(`db.migrate: dropped ${info.changes} obsolete named_types (File/Folder/Location/Span)`);
    } catch { /* ok */ }

    // Backfill `provider`/`sessionId` on pre-multi-provider AgentSession rows.
    // Originally only Claude sessions existed; their ids were raw UUIDs and the
    // schema didn't carry `provider`. Now we namespace as `claude:<uuid>` and
    // store the provider explicitly. We rewrite ONLY rows whose sessionId
    // doesn't already carry a `<provider>:` prefix — anything namespaced is
    // assumed correct.
    try {
      const sessions = this.raw.prepare(
        `SELECT n.id FROM nodes n JOIN named_types nt ON nt.type_id=n.type_id WHERE nt.name='AgentSession'`,
      ).all() as Array<{ id: string }>;
      let patched = 0;
      const PROVIDER_PREFIX_RE = /^(claude|codex|pi):/;
      const upsertField = this.raw.transaction((mapId: string, key: string, valueId: string) => {
        const existing = this.raw.prepare(
          `SELECT value_id FROM map_entries WHERE map_id=? AND key=?`,
        ).get(mapId, key) as { value_id: string } | undefined;
        if (existing) {
          this.raw.prepare(`UPDATE map_entries SET value_id=? WHERE map_id=? AND key=?`).run(valueId, mapId, key);
        } else {
          this.raw.prepare(`INSERT INTO map_entries(map_id, key, value_id) VALUES(?,?,?)`).run(mapId, key, valueId);
        }
      });
      const newSymbol = (value: string): string => {
        const id = uuidv4();
        this.raw.prepare(`INSERT INTO nodes(id, kind, symbol_value) VALUES(?,?,?)`).run(id, 'symbol', value);
        return id;
      };
      for (const { id } of sessions) {
        const provRow = this.raw.prepare(
          `SELECT n.symbol_value AS v FROM map_entries me JOIN nodes n ON n.id=me.value_id WHERE me.map_id=? AND me.key='provider'`,
        ).get(id) as { v: string | null } | undefined;
        if (provRow && provRow.v) continue;

        const sidRow = this.raw.prepare(
          `SELECT n.id AS nid, n.symbol_value AS v FROM map_entries me JOIN nodes n ON n.id=me.value_id WHERE me.map_id=? AND me.key='sessionId'`,
        ).get(id) as { nid: string; v: string | null } | undefined;

        if (sidRow && sidRow.v && !PROVIDER_PREFIX_RE.test(sidRow.v)) {
          // Rewrite the existing sessionId symbol value in-place.
          this.raw.prepare(`UPDATE nodes SET symbol_value=? WHERE id=?`).run(`claude:${sidRow.v}`, sidRow.nid);
        }

        upsertField(id, 'provider', newSymbol('claude'));
        patched++;
      }
      if (patched > 0) {
        log(`db.migrate: patched ${patched} AgentSession nodes with provider='claude'`);
        // node_refs may reference the rewritten sessionId symbol nodes; the
        // edge index keys on node ids, not symbol values, so it stays valid.
      }
    } catch (err) {
      log(`db.migrate: AgentSession provider backfill failed: ${(err as Error).message}`);
    }

    // Existing log-event nodes (UserInput/FileOperation/etc.) carry a
    // `sessionId` field whose value is the pre-namespace Claude UUID. Patch
    // those to `claude:<uuid>` so they continue to link to their parent
    // AgentSession via that string. Only events whose sessionId lacks a
    // provider prefix are touched.
    try {
      const EVENT_TYPES = ['UserInput', 'FileOperation', 'ShellExecution', 'AgentQuestion', 'AgentMessage', 'AgentSummary'];
      const placeholders = EVENT_TYPES.map(() => '?').join(',');
      const rows = this.raw.prepare(
        `SELECT n.id AS sym_id, n.symbol_value AS v
         FROM nodes n
         JOIN map_entries me ON me.value_id = n.id
         JOIN nodes parent ON parent.id = me.map_id
         JOIN named_types nt ON nt.type_id = parent.type_id
         WHERE nt.name IN (${placeholders})
           AND me.key = 'sessionId'
           AND n.kind = 'symbol'
           AND n.symbol_value NOT LIKE 'claude:%'
           AND n.symbol_value NOT LIKE 'codex:%'
           AND n.symbol_value NOT LIKE 'pi:%'`,
      ).all(...EVENT_TYPES) as Array<{ sym_id: string; v: string }>;
      const txn = this.raw.transaction(() => {
        const stmt = this.raw.prepare(`UPDATE nodes SET symbol_value=? WHERE id=?`);
        for (const r of rows) stmt.run(`claude:${r.v}`, r.sym_id);
      });
      txn();
      if (rows.length > 0) log(`db.migrate: namespaced ${rows.length} event sessionId symbols as claude:*`);
    } catch (err) {
      log(`db.migrate: event sessionId namespacing failed: ${(err as Error).message}`);
    }
  }

  // ── Type upsert ────────────────────────────────────────────────────────────
  //
  // Structural types (ListType, OrType, MapType) are deduplicated by a
  // content_key — a deterministic fingerprint built from the child type IDs.
  // This prevents duplicate rows from accumulating across repeated sync runs.
  //
  // RefType rows are deduplicated by ref_name.
  // SymbolType / MeaningType are global singletons (at most one row each).

  upsertType(type: Type, cache: Map<Type, string> = new Map(), namedName?: string): string {
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

    if (type.kind === 'OrType') {
      // OrType is N-ary and flat (no nested Or — enforced at YAML resolve).
      // Variant ids are sorted for the content_key so dedup is stable
      // regardless of YAML listing order; storage preserves declared order
      // via type_children.position.
      const variantIds = type.variants.map(v => this.upsertType(v, cache));
      const contentKey = 'OR:{' + [...variantIds].sort().join('|') + '}';
      return this.upsertStructural('OrType', contentKey, cache, type, id => {
        const stmt = this.raw.prepare(
          `INSERT INTO type_children(type_id, position, child_type_id) VALUES(?,?,?)`,
        );
        for (let i = 0; i < variantIds.length; i++) stmt.run(id, i, variantIds[i]!);
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
      // When a namedName is provided, use it as the content key prefix so that
      // structurally identical named types (e.g. all Lsp* types) each get their
      // own unique type_id rather than colliding on the same structural fingerprint.
      const contentKey = namedName
        ? `NT:{${namedName}}`
        : 'M:{' +
          Object.entries(fieldIds)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => `${k}=${v}`)
            .join(',') +
          '}';
      const insertChildren = (id: string) => {
        for (const [key, valId] of Object.entries(fieldIds)) {
          this.raw
            .prepare(`INSERT INTO type_map_entries(type_id, key, value_type_id) VALUES(?,?,?)`)
            .run(id, key, valId);
        }
      };
      const id = this.upsertStructural('MapType', contentKey, cache, type, insertChildren);

      // Named-type maps are identified by NAME, not structure — so when the
      // YAML definition gains/loses/changes fields, the existing row stays
      // (content_key still matches) but its type_map_entries are stale. Detect
      // drift and replace the children.
      if (namedName) {
        const currentRows = this.raw
          .prepare(`SELECT key, value_type_id FROM type_map_entries WHERE type_id=?`)
          .all(id) as Array<{ key: string; value_type_id: string }>;
        const current = new Map(currentRows.map(r => [r.key, r.value_type_id]));
        let drift = current.size !== Object.keys(fieldIds).length;
        if (!drift) {
          for (const [k, v] of Object.entries(fieldIds)) {
            if (current.get(k) !== v) { drift = true; break; }
          }
        }
        if (drift) {
          this.raw.prepare(`DELETE FROM type_map_entries WHERE type_id=?`).run(id);
          insertChildren(id);
        }
      }

      return id;
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
   * Remove type rows that are no longer reachable from any named type AND
   * have no surviving node referencing them. Returns the number of deleted
   * rows. Call after bulk sync operations to keep the types table clean.
   *
   * Types that are unreachable from named_types but still referenced by an
   * existing node are LEFT IN PLACE — those node rows are stuck on an old
   * version of their named type until they're explicitly migrated/deleted.
   * Skipping them avoids a foreign-key cascade that would silently drop user
   * data on a routine type-sync.
   */
  gcOrphanedTypes(): number {
    // FK constraints on type_children.child_type_id / type_map_entries.value_type_id
    // are non-cascading, so when a big disconnected chunk of orphan types
    // needs to go (e.g. after a named-type rename or directory-schema flatten)
    // the bulk-delete temporarily violates them mid-statement. Disable FKs
    // for the cleanup — at the end of the operation the surviving types form
    // a consistent graph again because anything left behind is still
    // node-referenced or reachable from named_types.
    this.raw.pragma('foreign_keys = OFF');
    let changes = 0;
    try {
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
        DELETE FROM types
         WHERE id NOT IN (SELECT id FROM reachable)
           AND id NOT IN (SELECT DISTINCT type_id FROM nodes WHERE type_id IS NOT NULL)
      `).run();
      changes = info.changes;
    } finally {
      this.raw.pragma('foreign_keys = ON');
    }
    return changes;
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

    if (kind === 'OrType') {
      const result: Extract<Type, { kind: 'OrType' }> = { kind: 'OrType', variants: [] };
      cache.set(id, result);
      const children = this.raw
        .prepare(`SELECT child_type_id FROM type_children WHERE type_id=? ORDER BY position`)
        .all(id) as { child_type_id: string }[];
      result.variants = children.map(c => this.loadTypeImpl(c.child_type_id, cache, resolveRefs));
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

    // 3. Emit insert event with the root's named type if any.
    const typeName = this.getNodeTypeName(rootId);
    this.emitInsert({ ids: [rootId], typeNames: typeName ? [typeName] : [] });

    return rootId;
  }

  private async collectEmbeds(node: Node, out: Map<string, Float32Array>): Promise<void> {
    if (node.kind === 'atom' && node.atom.kind === 'meaning') {
      const { text, vec } = node.atom.value;
      // Use the provided vec if already the right size; otherwise embed
      const key = text;
      if (!out.has(key) && text !== '') {
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
      const now = Date.now();
      this.raw
        .prepare(`INSERT INTO nodes(id, kind, type_id, created_at, updated_at) VALUES(?,?,?,?,?)`)
        .run(id, 'map', typeId, now, now);
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
      const text = atom.value.text;
      this.raw
        .prepare(`INSERT INTO nodes(id, kind, meaning_text) VALUES(?,?,?)`)
        .run(id, 'meaning', text);
      // Skip embedding for empty meanings — they have no semantic content and
      // would pollute vector-search results with arbitrarily-ranked zero rows.
      const vec = embeds.get(text);
      if (vec) {
        this.raw
          .prepare(`INSERT INTO meaning_vecs(node_id, embedding) VALUES(?,?)`)
          .run(id, vec);
      }
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
    // Per-entry effective state: the value to write into nodes.state.
    //  - `null`  → leave nodes.state NULL (default `[ready]`, single final).
    //  - string  → write this explicit state.
    // Captured here so phase 4 can persist + emit state-change consistently.
    const targetStates: Array<string | null> = entries.map(() => null);
    // Patches that need to fire a state-change after their fields land.
    const stateBumps = new Map<number, { from: string | null; to: string }>();

    const typeInfos: Array<{ typeId: string; schema: Extract<Type, { kind: 'MapType' }>; states: string[] } | null> = [];
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]!;

      // For patch entries verify the existing node exists and has a compatible type.
      if (entry.id) {
        // Reject empty patch — there's nothing to do.
        if (Object.keys(entry.data).length === 0 && entry.state == null) {
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

        const states = this.getStatesForType(entry.type);
        const finalState = states[states.length - 1]!;
        const currentRaw = this.getNodeState(entry.id);
        const currentEffective = currentRaw ?? finalState;

        // Final-state immutability — only relaxed when the patch supplies an
        // explicit $state to bump out of the final slot. Single-state types
        // (default `[ready]`) are always immutable: their only state IS final.
        if (currentEffective === finalState && entry.state == null) {
          errors.push({
            index: i,
            path: '',
            message: `Node "${entry.id}" is in final state '${finalState}' for type "${entry.type}" and is immutable. Provide $state to bump it out of the final state, or delete and re-insert.`,
          });
          typeInfos.push(null);
          continue;
        }

        if (entry.state != null) {
          if (!states.includes(entry.state)) {
            errors.push({
              index: i,
              path: '',
              message: `$state "${entry.state}" not in [${states.join(', ')}] for type "${entry.type}"`,
            });
            typeInfos.push(null);
            continue;
          }
          if (entry.state !== currentEffective) {
            stateBumps.set(i, { from: currentRaw, to: entry.state });
            // For multi-state types we write the explicit state. For single-
            // state types the only state IS the bump target; that's a no-op
            // we can safely encode by keeping NULL.
            targetStates[i] = states.length > 1 ? entry.state : null;
          }
        }

        typeInfos.push({ typeId: row.type_id, schema, states });
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

      const states = this.getStatesForType(entry.type);
      const initialState = entry.state ?? states[0]!;
      if (entry.state != null && !states.includes(entry.state)) {
        errors.push({
          index: i,
          path: '',
          message: `$state "${entry.state}" not in [${states.join(', ')}] for type "${entry.type}"`,
        });
        typeInfos.push(null);
        continue;
      }
      // Only persist state for multi-state types — single-state ones encode
      // their (only & final) state as NULL.
      targetStates[i] = states.length > 1 ? initialState : null;

      typeInfos.push({ typeId: named.typeId, schema, states });
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
    for (const text of meaningTexts) if (text !== '') embedMap.set(text, await this.embed(text));

    // Wall-clock anchor for every node touched by this batch. One value
    // makes equal-time inserts / patches share an exact timestamp so range
    // queries that bracket the batch don't miss entries.
    const nowMs = Date.now();

    // ── Phase 4: write in a single transaction ──────────────────────────────
    const txn = this.raw.transaction(() => {
      // Insert shells for new entries first so $ref can resolve them.
      for (let i = 0; i < entries.length; i++) {
        const ti = typeInfos[i];
        const id = allocatedIds[i];
        if (!ti || !id || entries[i]!.id) continue; // skip patches and failed entries
        const entry = entries[i]!;
        const createdAt = entry.createdAt ?? nowMs;
        const updatedAt = entry.updatedAt ?? createdAt;
        this.raw
          .prepare(
            `INSERT INTO nodes(id, kind, type_id, state, created_at, updated_at)
             VALUES(?,?,?,?,?,?)`,
          )
          .run(id, 'map', ti.typeId, targetStates[i], createdAt, updatedAt);
      }

      // Apply patch-driven state bumps (multi-state types only — single-state
      // bumps short-circuit to a no-op above).
      for (let i = 0; i < entries.length; i++) {
        const id = allocatedIds[i];
        if (!id || !entries[i]!.id) continue;
        if (!stateBumps.has(i)) continue;
        const ti = typeInfos[i];
        if (!ti || ti.states.length <= 1) continue;
        this.raw.prepare(`UPDATE nodes SET state=? WHERE id=?`).run(targetStates[i], id);
      }

      // Bump `updated_at` on every patched entry (state change or not). The
      // caller can override via `$updated_at`; otherwise the batch's nowMs
      // wins. created_at is never touched on a patch.
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]!;
        const id = allocatedIds[i];
        if (!id || !entry.id) continue; // patches only
        const updatedAt = entry.updatedAt ?? nowMs;
        this.raw.prepare(`UPDATE nodes SET updated_at=? WHERE id=?`).run(updatedAt, id);
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

    // Update materialized edge index for every touched entry (inserts and
    // patches alike — patches may have added new $id refs). INSERT OR IGNORE
    // keeps it idempotent if a root is walked again later.
    const touchedIds = allocatedIds.filter((id): id is string => typeof id === 'string');
    if (touchedIds.length > 0) {
      try {
        populateNodeRefsFor(this.raw, touchedIds);
      } catch (err) {
        log(`insertEntries: populateNodeRefs failed: ${(err as Error).message}`);
      }
    }

    // Emit one event covering all newly-inserted (non-patch) entries.
    const insertedIds: string[] = [];
    const typeNameSet = new Set<string>();
    for (let i = 0; i < entries.length; i++) {
      const id = allocatedIds[i];
      const entry = entries[i]!;
      if (!id || entry.id) continue; // skip failed and patches
      insertedIds.push(id);
      typeNameSet.add(entry.type);
    }
    if (insertedIds.length > 0) {
      this.emitInsert({ ids: insertedIds, typeNames: Array.from(typeNameSet) });
    }

    // Emit one state-change event per patch that bumped state. Listeners
    // (e.g. the scheduler) react to these to mark `onNodeState` jobs pending.
    for (let i = 0; i < entries.length; i++) {
      const bump = stateBumps.get(i);
      const id = allocatedIds[i];
      const entry = entries[i]!;
      if (!bump || !id) continue;
      this.emitNodeEvent({
        kind: 'state-change',
        ids: [id],
        typeNames: [entry.type],
        state: bump.to,
        fromState: bump.from,
      });
    }

    log(`insertEntries: done, ${errors.length} errors`);
    return { ids: allocatedIds, errors, skippedKeys };
  }

  /**
   * Recursively collect meaning strings from entry data following the shallow
   * type schema, so embeddings can be pre-computed before the transaction.
   */
  private collectEntryMeanings(value: unknown, type: Type, out: Set<string>): void {
    if (value == null) return;
    if (typeof value === 'object' && ('$ref' in (value as object) || '$id' in (value as object))) return;

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
      if (value !== '') out.add(value);
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
   * Collect the set of named-type names this field's TYPE may legitimately
   * reference via `$id` / `$ref`. Walks Optional / Or / Ref to gather them.
   * For atom / list / anonymous map types returns an empty set, meaning
   * "$id refs aren't valid here" — the existing type branches handle that
   * via their own shape checks.
   */
  private collectAllowedNamedTypes(type: Type, out = new Set<string>()): Set<string> {
    if (type.kind === 'RefType') out.add(type.name);
    else if (type.kind === 'OptionalType') this.collectAllowedNamedTypes(type.inner, out);
    else if (type.kind === 'OrType') {
      for (const v of type.variants) this.collectAllowedNamedTypes(v, out);
    }
    // SymbolType / MeaningType / ListType / MapType contribute nothing.
    return out;
  }

  /**
   * After resolving a `$id` / `$ref` to a node id, verify the referenced
   * node's named type is in the field's allowed set. Throws on mismatch.
   * No-op when the field type doesn't accept refs at all (e.g. SymbolType).
   */
  private assertRefTypeCompatible(nodeId: string, type: Type, path: string): void {
    const allowed = this.collectAllowedNamedTypes(type);
    if (allowed.size === 0) return;
    const row = this.raw.prepare(
      `SELECT nt.name AS name
         FROM nodes n
         LEFT JOIN named_types nt ON nt.type_id = n.type_id
        WHERE n.id = ?`,
    ).get(nodeId) as { name: string | null } | undefined;
    const actual = row?.name ?? null;
    if (!actual || !allowed.has(actual)) {
      throw new Error(
        `${path} "${nodeId}": referenced node has type "${actual ?? '<none>'}"; ` +
        `field accepts ${[...allowed].sort().join(' | ')}`,
      );
    }
  }

  /**
   * Build (insert) a node for a single field value given its shallow schema type.
   * Called inside the transaction; must be synchronous.
   *
   * `{ "$ref": N }` resolves to the pre-allocated ID of the N-th top-level entry.
   * `{ "$id": "uuid" }` references an existing node already present in the DB.
   */
  private buildEntryNode(
    value: unknown,
    type: Type,
    allocatedIds: (string | null)[],
    embedMap: Map<string, Float32Array>,
    path: string,
  ): string {
    // $ref — circular/forward reference to a top-level entry in the same batch
    if (value !== null && typeof value === 'object' && '$ref' in (value as object)) {
      const idx = (value as { $ref: number }).$ref;
      const id = allocatedIds[idx];
      if (id == null)
        throw new Error(`$ref[${idx}]: entry does not exist or failed type validation`);
      this.assertRefTypeCompatible(id, type, `${path}.$ref[${idx}]`);
      return id;
    }

    // $id — reference to an existing node already in the DB
    if (value !== null && typeof value === 'object' && '$id' in (value as object)) {
      const nodeId = (value as { $id: string }).$id;
      if (typeof nodeId !== 'string')
        throw new Error(`${path}.$id: expected string, got ${typeof nodeId}`);
      const row = this.raw.prepare(`SELECT id FROM nodes WHERE id=?`).get(nodeId) as { id: string } | undefined;
      if (!row)
        throw new Error(`${path}.$id "${nodeId}": node does not exist in the database`);
      this.assertRefTypeCompatible(nodeId, type, `${path}.$id`);
      return nodeId;
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

    // OrType — try each variant; the first that doesn't throw wins. Empty
    // values (null/undefined) are filtered out before we get here, so this
    // is for legitimate values whose shape happens to match ONE of the
    // declared union arms.
    if (type.kind === 'OrType') {
      const errs: string[] = [];
      for (const v of type.variants) {
        try { return this.buildEntryNode(value, v, allocatedIds, embedMap, path); }
        catch (e) { errs.push(`${typeKindLabel(v)}: ${(e as Error).message}`); }
      }
      throw new Error(`${path}: no Or variant matched. Tried:\n  ${errs.join('\n  ')}`);
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
      // Skip embedding for empty meanings — see insertNode's atom='meaning' branch.
      const vec = embedMap.get(value);
      if (vec) {
        this.raw.prepare(`INSERT INTO meaning_vecs(node_id, embedding) VALUES(?,?)`).run(id, vec);
      }
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
      // Nested anonymous maps inherit the batch's wall-clock anchor — they
      // can't be overridden individually (no `$created_at` plumbing for
      // sub-objects), so a single Date.now() per nested insert is fine.
      const now = Date.now();
      this.raw
        .prepare(`INSERT INTO nodes(id, kind, type_id, created_at, updated_at) VALUES(?,?,?,?,?)`)
        .run(id, 'map', typeId, now, now);
      for (const [key, fieldType] of Object.entries(type.entries)) {
        if (obj[key] == null) continue;
        const valId = this.buildEntryNode(obj[key], fieldType, allocatedIds, embedMap, `${path}.${key}`);
        this.raw.prepare(`INSERT INTO map_entries(map_id, key, value_id) VALUES(?,?,?)`).run(id, key, valId);
      }
      return id;
    }

    // Exhaustiveness — every Type variant should be handled above.
    throw new Error(`${path}: unsupported type kind "${(type as { kind: string }).kind}"`);
  }

  // ── Node loading ───────────────────────────────────────────────────────────

  loadNode(id: string): Node {
    const row = this.raw
      .prepare(
        `SELECT id, kind,
                symbol_value  AS symbolValue,
                meaning_text  AS meaningText,
                type_id       AS typeId,
                created_at    AS createdAt,
                updated_at    AS updatedAt
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
                type_id       AS typeId,
                created_at    AS createdAt,
                updated_at    AS updatedAt
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

    const childAncestors = new Set(ancestors);
    childAncestors.add(id);

    if (row.kind === 'list') {
      // Lists are transparent — they're collections, not entities. They don't
      // consume depth budget. Items inherit the parent's depth and hit the
      // named-map-truncation rule normally.
      const items = this.raw
        .prepare(`SELECT item_id FROM list_items WHERE list_id=? ORDER BY position`)
        .all(id) as { item_id: string }[];
      return {
        kind: 'list',
        items: items.map(r => this.loadNodeDeep(r.item_id, depth, childAncestors)),
      };
    }

    if (row.kind === 'map') {
      const namedRow = this.raw
        .prepare(`SELECT name FROM named_types WHERE type_id=?`)
        .get(row.typeId!) as { name: string } | undefined;
      const isNamed = !!namedRow;

      // Only NAMED maps consume depth. Anonymous structural maps (rare in
      // current YAMLs) are transparent like lists.
      if (isNamed && depth === 0) return { kind: 'ref', id };
      const childDepth = isNamed ? depth - 1 : depth;

      const entries = this.raw
        .prepare(`SELECT key, value_id FROM map_entries WHERE map_id=?`)
        .all(id) as { key: string; value_id: string }[];
      const type = this.loadType(row.typeId!);
      const result: Record<Sym, DeepNode> = {};
      for (const { key, value_id } of entries) {
        result[key] = this.loadNodeDeep(value_id, childDepth, childAncestors);
      }
      // Resolve $state: stored value wins; NULL falls back to the type's
      // final state when the type declares a state machine. Single-state
      // types report their only state.
      let state: string | undefined;
      if (namedRow) {
        const stored = this.getNodeState(id);
        if (stored != null) {
          state = stored;
        } else {
          const states = this.getStatesForType(namedRow.name);
          state = states[states.length - 1];
        }
      }
      return {
        kind: 'map',
        id,
        entries: result,
        type,
        typeName: namedRow?.name,
        state,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
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

  /** Matches symbol_value for kind='symbol' nodes AND meaning_text for kind='meaning' nodes. */
  querySymbolRegex(pattern: string): string[] {
    const rows = this.raw
      .prepare(`SELECT id FROM nodes WHERE (kind='symbol' AND regexp(?, symbol_value)) OR (kind='meaning' AND regexp(?, meaning_text))`)
      .all(pattern, pattern) as { id: string }[];
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
   * Range query over `nodes.created_at` / `updated_at`. Restricted to
   * `kind='map'` because atom/list rows leave the timestamp columns NULL.
   * Both `<` and `>` are strict — callers wanting an inclusive range can
   * pass the exact boundary value (the `nowMs` shared across an insert
   * batch lands on a single value, so `before NOW` and `after NOW` never
   * overlap).
   */
  queryByTime(field: 'created_at' | 'updated_at', op: 'before' | 'after', ms: number): string[] {
    const col = field === 'created_at' ? 'created_at' : 'updated_at';
    const comparator = op === 'before' ? '<' : '>';
    const rows = this.raw
      .prepare(`SELECT id FROM nodes WHERE kind='map' AND ${col} ${comparator} ?`)
      .all(ms) as { id: string }[];
    return rows.map(r => r.id);
  }

  /**
   * Fetch `created_at` / `updated_at` for a node without loading its
   * contents. Returns null for atom/list rows (which leave the columns
   * NULL) and for missing nodes.
   */
  getNodeTimestamps(id: string): { createdAt: number; updatedAt: number } | null {
    const row = this.raw
      .prepare(`SELECT created_at AS createdAt, updated_at AS updatedAt FROM nodes WHERE id=?`)
      .get(id) as { createdAt: number | null; updatedAt: number | null } | undefined;
    if (!row || row.createdAt == null || row.updatedAt == null) return null;
    return { createdAt: row.createdAt, updatedAt: row.updatedAt };
  }

  /**
   * Return the node ID stored at a specific key in a map node.
   * Returns null if the map does not have that key.
   */
  getMapFieldId(mapId: string, key: string): string | null {
    const row = this.raw
      .prepare(`SELECT value_id FROM map_entries WHERE map_id=? AND key=?`)
      .get(mapId, key) as { value_id: string } | undefined;
    return row?.value_id ?? null;
  }

  /**
   * Insert a fresh Symbol atom node with the given value and return its id.
   * Useful for callers that need to append plain symbol strings into an
   * existing list field (e.g. Plan.relatedFiles).
   */
  insertSymbolNode(value: string): string {
    const id = uuidv4();
    this.raw.prepare(`INSERT INTO nodes(id, kind, symbol_value) VALUES(?,?,?)`).run(id, 'symbol', value);
    return id;
  }

  /**
   * Append item node IDs to an existing list node.
   * Items are added after any existing items, preserving their original positions.
   * No-op if itemIds is empty.
   */
  appendListItems(listId: string, itemIds: string[]): void {
    if (itemIds.length === 0) return;
    const maxRow = this.raw
      .prepare(`SELECT COALESCE(MAX(position), -1) AS max FROM list_items WHERE list_id=?`)
      .get(listId) as { max: number };
    let pos = maxRow.max + 1;
    const txn = this.raw.transaction(() => {
      for (const itemId of itemIds) {
        this.raw
          .prepare(`INSERT INTO list_items(list_id, position, item_id) VALUES(?,?,?)`)
          .run(listId, pos++, itemId);
      }
    });
    txn();
  }

  /** Return the item node IDs in a list, in position order. */
  getListItems(listId: string): string[] {
    const rows = this.raw
      .prepare(`SELECT item_id FROM list_items WHERE list_id=? ORDER BY position`)
      .all(listId) as Array<{ item_id: string }>;
    return rows.map(r => r.item_id);
  }

  /**
   * Append item node IDs to a list, skipping IDs already present. Returns the
   * number of items actually appended. Also refreshes node_refs for any
   * named-type ancestor of the list so the materialized edge index stays
   * consistent with the new contents.
   */
  appendListItemsUnique(listId: string, itemIds: string[]): number {
    if (itemIds.length === 0) return 0;
    const existing = new Set(
      (this.raw.prepare(`SELECT item_id FROM list_items WHERE list_id=?`).all(listId) as Array<{ item_id: string }>)
        .map(r => r.item_id),
    );
    const toAdd = [...new Set(itemIds)].filter(id => !existing.has(id));
    if (toAdd.length === 0) return 0;

    this.appendListItems(listId, toAdd);

    // Refresh node_refs for the nearest named-type ancestor (and its ancestors).
    // We walk up via map_entries / list_items until we hit a named-type node,
    // then repopulate that root. Cheap relative to query cost; INSERT OR IGNORE
    // keeps it idempotent.
    try {
      const parent = this.findNamedParent(listId);
      if (parent) populateNodeRefsFor(this.raw, [parent.id]);
    } catch { /* best-effort */ }

    return toAdd.length;
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

  /**
   * Find named-type nodes that reference `targetId` from somewhere in their
   * subtree. Backed by the materialized `node_refs` index.
   */
  findReferencingNamedNodes(targetId: string, limit = 50): { id: string; typeName: string }[] {
    const rows = this.raw.prepare(`
      SELECT DISTINCT src_id AS id, src_type AS typeName
      FROM node_refs
      WHERE dst_id = ?
      LIMIT ?
    `).all(targetId, limit) as { id: string; typeName: string }[];
    return rows;
  }

  /**
   * Collect every named-type node referenced from somewhere inside the subtree
   * rooted at `rootId`. Backed by the materialized `node_refs` index.
   *
   * The `depth` parameter is preserved for API compatibility but no longer
   * used — node_refs stores transitive edges directly.
   */
  collectOutgoingNamedRefs(rootId: string, _depth = 10): { id: string; typeName: string }[] {
    const rows = this.raw.prepare(`
      SELECT DISTINCT dst_id AS id, dst_type AS typeName
      FROM node_refs
      WHERE src_id = ?
    `).all(rootId) as { id: string; typeName: string }[];
    return rows;
  }

  /** Rebuild the materialized `node_refs` index from scratch. */
  rebuildNodeRefs(): { rows: number } {
    return rebuildNodeRefs(this.raw);
  }

  /** True if the `node_refs` index has any rows. Used to gate one-shot backfill. */
  hasNodeRefs(): boolean {
    const row = this.raw.prepare(`SELECT 1 AS x FROM node_refs LIMIT 1`).get() as { x: number } | undefined;
    return !!row;
  }

  // ── Event file-context (hidden from MCP/UI) ────────────────────────────────
  //
  // `event_file_context(event_id, file_path)` is a per-text-event allowlist of
  // file paths the event is "about" in its containing session. It's populated
  // by the agent-log indexer from Write/Edit tool-call boundaries and consumed
  // by the enricher + LSP reverse pass to gate which LSP symbols a given event
  // can possibly link to. Not exposed via MCP tools or the graph API.

  /** Replace the file-context rows for the given event ids in one transaction. */
  writeEventFileContext(rows: Array<{ eventId: string; filePath: string }>): void {
    if (rows.length === 0) return;
    const ids = new Set(rows.map(r => r.eventId));
    const placeholders = [...ids].map(() => '?').join(',');
    const del = this.raw.prepare(`DELETE FROM event_file_context WHERE event_id IN (${placeholders})`);
    const ins = this.raw.prepare(`INSERT OR IGNORE INTO event_file_context(event_id, file_path) VALUES(?,?)`);
    const txn = this.raw.transaction(() => {
      del.run(...ids);
      for (const r of rows) ins.run(r.eventId, r.filePath);
    });
    txn();
  }

  /** Read the file-context allowlist for one event id. */
  getEventFileContext(eventId: string): string[] {
    const rows = this.raw
      .prepare(`SELECT file_path FROM event_file_context WHERE event_id = ?`)
      .all(eventId) as Array<{ file_path: string }>;
    return rows.map(r => r.file_path);
  }

  /**
   * Find every LSP* node whose `file_path` field is in `paths`. Used by the
   * enricher to narrow candidate ancestors to "files this event is about".
   * Single indexed scan over `map_entries` + `nodes` — that's the whole reason
   * we flattened the Location subtree.
   */
  lspSymbolsByFilePaths(paths: string[]): string[] {
    if (paths.length === 0) return [];
    const placeholders = paths.map(() => '?').join(',');
    const rows = this.raw.prepare(`
      SELECT DISTINCT pn.id FROM nodes pn
      JOIN named_types nt ON nt.type_id = pn.type_id
      JOIN map_entries me ON me.map_id = pn.id AND me.key = 'file_path'
      JOIN nodes child ON child.id = me.value_id
      WHERE nt.name LIKE 'Lsp%'
        AND child.kind = 'symbol'
        AND child.symbol_value IN (${placeholders})
    `).all(...paths) as Array<{ id: string }>;
    return rows.map(r => r.id);
  }

  /**
   * Group `event_file_context` rows by file path. Used by the LSP reverse
   * pass to look up "which events are about file F?" in one query.
   */
  eventsByFilePath(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    const rows = this.raw
      .prepare(`SELECT file_path, event_id FROM event_file_context`)
      .all() as Array<{ file_path: string; event_id: string }>;
    for (const r of rows) {
      const arr = out.get(r.file_path) ?? [];
      arr.push(r.event_id);
      out.set(r.file_path, arr);
    }
    return out;
  }

  // ── Plan acceptance (hidden from MCP/UI) ───────────────────────────────────
  //
  // `plan_acceptances(plan_slug, session_id)` links Claude / Codex / pi.dev
  // sessions to the Plan markdown they accepted via ExitPlanMode. Plans
  // indexed without at least one accepting session are treated as orphans
  // (likely produced by a different project, since `~/.claude/plans/` is a
  // global directory) and skipped.

  /** Record one ExitPlanMode acceptance. Idempotent. */
  writePlanAcceptance(planSlug: string, sessionId: string, timestamp: string): void {
    this.raw.prepare(
      `INSERT OR IGNORE INTO plan_acceptances(plan_slug, session_id, timestamp) VALUES(?,?,?)`,
    ).run(planSlug, sessionId, timestamp);
  }

  /** Sessions that accepted a plan, newest first. */
  getAcceptingSessions(planSlug: string): Array<{ sessionId: string; timestamp: string }> {
    const rows = this.raw.prepare(
      `SELECT session_id, timestamp FROM plan_acceptances WHERE plan_slug = ? ORDER BY timestamp DESC`,
    ).all(planSlug) as Array<{ session_id: string; timestamp: string }>;
    return rows.map(r => ({ sessionId: r.session_id, timestamp: r.timestamp }));
  }

  /**
   * Union of `FileOperation.path` values across every session that accepted
   * the plan. Used by the LSP reverse pass to constrain symbol linking to
   * the files the accepting sessions actually touched.
   */
  getPlanFilePaths(planSlug: string): string[] {
    const rows = this.raw.prepare(`
      SELECT DISTINCT path_node.symbol_value AS file_path
      FROM plan_acceptances pa
      JOIN map_entries me_sid ON me_sid.key = 'sessionId'
      JOIN nodes sid_atom    ON sid_atom.id = me_sid.value_id
                              AND sid_atom.kind = 'symbol'
                              AND sid_atom.symbol_value = pa.session_id
      JOIN nodes fileop_node ON fileop_node.id = me_sid.map_id
      JOIN named_types nt    ON nt.type_id = fileop_node.type_id AND nt.name = 'FileOperation'
      JOIN map_entries me_path ON me_path.map_id = fileop_node.id AND me_path.key = 'path'
      JOIN nodes path_node     ON path_node.id = me_path.value_id AND path_node.kind = 'symbol'
      WHERE pa.plan_slug = ?
    `).all(planSlug) as Array<{ file_path: string }>;
    return rows.map(r => r.file_path);
  }

  // ── Scheduler heartbeat ────────────────────────────────────────────────────

  /** Upsert the single-row heartbeat. Called by the running scheduler every 2s. */
  writeHeartbeat(pid: number): void {
    this.raw
      .prepare(
        `INSERT INTO scheduler_heartbeats(id, last_seen_at, pid)
         VALUES(1, datetime('now'), ?)
         ON CONFLICT(id) DO UPDATE
           SET last_seen_at = excluded.last_seen_at,
               pid          = excluded.pid`,
      )
      .run(pid);
  }

  /** Read the single-row heartbeat. Returns null if no scheduler has ever written one. */
  readHeartbeat(): { lastSeenAt: string; pid: number | null } | null {
    const row = this.raw
      .prepare(`SELECT last_seen_at AS lastSeenAt, pid FROM scheduler_heartbeats WHERE id = 1`)
      .get() as { lastSeenAt: string; pid: number | null } | undefined;
    return row ?? null;
  }

  // ── Vector search (with full node loading) ─────────────────────────────────

  async searchByText(query: string, limit = 10, offset = 0): Promise<SearchResult[]> {
    const vec = await this.embed(query);
    // Over-fetch so we can drop empty-meaning rows (legacy data) without
    // shrinking the page below the caller's requested limit.
    const fetchK = (limit + offset) * 2;
    const rows = this.raw
      .prepare(
        `SELECT node_id, distance FROM meaning_vecs
         WHERE embedding MATCH ? AND k=? ORDER BY distance`,
      )
      .all(vec, fetchK) as { node_id: string; distance: number }[];

    const out: SearchResult[] = [];
    for (const r of rows) {
      const node = this.loadNode(r.node_id);
      if (
        node.kind === 'atom' &&
        node.atom.kind === 'meaning' &&
        (!node.atom.value.text || node.atom.value.text.trim() === '')
      ) {
        continue;
      }
      out.push({ nodeId: r.node_id, node, distance: r.distance });
    }
    return out.slice(offset, offset + limit);
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
    hidden?: boolean,
  ): void {
    this.raw
      .prepare(
        `INSERT INTO named_types(name, type_id, description, source, hidden, updated_at)
         VALUES(?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(name) DO UPDATE
           SET type_id=excluded.type_id,
               description=excluded.description,
               source=excluded.source,
               hidden=excluded.hidden,
               updated_at=excluded.updated_at`,
      )
      .run(name, typeId, description ?? null, source, hidden ? 1 : 0);
  }

  /** Returns true if the named type exists and is marked hidden. */
  isHiddenNamedType(name: string): boolean {
    const row = this.raw
      .prepare(`SELECT hidden FROM named_types WHERE name=?`)
      .get(name) as { hidden: number } | undefined;
    return row ? row.hidden === 1 : false;
  }

  /**
   * If the node itself is a map node whose type_id matches a named type,
   * returns that named type's name; otherwise returns null.
   * Used to filter query results where the node IS the named-type root.
   */
  getNodeTypeName(nodeId: string): string | null {
    const row = this.raw
      .prepare(
        `SELECT nt.name FROM nodes n
         JOIN named_types nt ON nt.type_id = n.type_id
         WHERE n.id = ? AND n.kind = 'map'`,
      )
      .get(nodeId) as { name: string } | undefined;
    return row?.name ?? null;
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

  // Skills are no longer DB-resident — see `loadSkillsFromDir` in
  // packages/core/src/skills.ts. The old `upsertSkill` / `getSkill` /
  // `listSkills` methods have been removed; callers should use the
  // filesystem registry directly.

  // ── Node-event bus ─────────────────────────────────────────────────────────

  /**
   * Subscribe to node-lifecycle events (`insert` and `state-change`).
   * Fired synchronously after the underlying write commits. Listeners that
   * throw are logged and never surface back to the caller.
   */
  onNodeEvent(listener: NodeEventListener): () => void {
    this.nodeEventListeners.add(listener);
    return () => { this.nodeEventListeners.delete(listener); };
  }

  /** @deprecated Use `onNodeEvent` and filter by `event.kind === 'insert'`. */
  onInsert(listener: NodeEventListener): () => void {
    return this.onNodeEvent(listener);
  }

  private emitNodeEvent(event: NodeEvent): void {
    for (const fn of this.nodeEventListeners) {
      try { fn(event); } catch (err) {
        log(`node-event listener error: ${(err as Error).message}`);
      }
    }
  }

  private emitInsert(event: Omit<NodeEvent, 'kind'>): void {
    this.emitNodeEvent({ kind: 'insert', ...event });
  }

  // ── State machine ──────────────────────────────────────────────────────────

  /**
   * Return the ordered state list for a named type. Defaults to `['ready']`
   * when no rows are configured. The last element is the final (immutable)
   * state.
   */
  getStatesForType(typeName: string): string[] {
    const rows = this.raw
      .prepare(
        `SELECT state FROM named_type_states WHERE type_name=? ORDER BY position`,
      )
      .all(typeName) as { state: string }[];
    if (rows.length === 0) return ['ready'];
    return rows.map(r => r.state);
  }

  /**
   * Overwrite the ordered state machine for a named type. Pass an empty array
   * to clear (which restores the default `['ready']` behaviour at read time).
   */
  setStatesForType(typeName: string, states: string[]): void {
    const txn = this.raw.transaction(() => {
      this.raw.prepare(`DELETE FROM named_type_states WHERE type_name=?`).run(typeName);
      const stmt = this.raw.prepare(
        `INSERT INTO named_type_states(type_name, position, state) VALUES(?,?,?)`,
      );
      for (let i = 0; i < states.length; i++) stmt.run(typeName, i, states[i]);
    });
    txn();
  }

  /**
   * Read a node's current state. Returns NULL when the node has no row, isn't
   * a named-type map, or its type declares no state machine.
   */
  getNodeState(nodeId: string): string | null {
    const row = this.raw
      .prepare(`SELECT state FROM nodes WHERE id=?`)
      .get(nodeId) as { state: string | null } | undefined;
    return row?.state ?? null;
  }

  /**
   * Move a node to a new state. The state must belong to the node's type's
   * declared state machine. No-op if the node is already at the target state.
   * Fires a `state-change` event on success.
   */
  setNodeState(nodeId: string, state: string): void {
    const typeName = this.getNodeTypeName(nodeId);
    if (!typeName) throw new Error(`setNodeState: node "${nodeId}" has no named type`);
    const states = this.getStatesForType(typeName);
    if (!states.includes(state)) {
      throw new Error(
        `setNodeState: state "${state}" not in [${states.join(', ')}] for type "${typeName}"`,
      );
    }
    const current = this.getNodeState(nodeId);
    if (current === state) return;
    this.raw.prepare(`UPDATE nodes SET state=? WHERE id=?`).run(state, nodeId);
    this.emitNodeEvent({
      kind: 'state-change',
      ids: [nodeId],
      typeNames: [typeName],
      state,
      fromState: current,
    });
  }

  // ── Catch-up polling helper ────────────────────────────────────────────────

  /**
   * Return node IDs (and their rowid) for nodes belonging to one of `typeNames`
   * whose rowid is strictly greater than `sinceRowid`. Used by the scheduler at
   * startup to fire `onTypeInsert` jobs for nodes that arrived while no
   * listener was attached.
   */
  findNodesOfTypeSince(typeNames: string[], sinceRowid: number): { id: string; rowid: number }[] {
    if (typeNames.length === 0) return [];
    const placeholders = typeNames.map(() => '?').join(',');
    const rows = this.raw
      .prepare(
        `SELECT n.rowid AS rowid, n.id AS id
           FROM nodes n
           JOIN named_types nt ON nt.type_id = n.type_id
          WHERE nt.name IN (${placeholders})
            AND n.rowid > ?
          ORDER BY n.rowid ASC`,
      )
      .all(...typeNames, sinceRowid) as { id: string; rowid: number }[];
    return rows;
  }

  /** Current maximum rowid in the `nodes` table — used as a fresh catch-up cursor. */
  maxNodeRowid(): number {
    const row = this.raw.prepare(`SELECT COALESCE(MAX(rowid), 0) AS max FROM nodes`).get() as { max: number };
    return row.max;
  }

  // ── Jobs ──────────────────────────────────────────────────────────────────

  /** Insert a new job row if absent. Returns true when a row was created. */
  upsertJob(name: string, opts: { description?: string; defaultEnabled?: boolean } = {}): boolean {
    const info = this.raw
      .prepare(
        `INSERT INTO jobs(name, description, enabled, status)
         VALUES(?, ?, ?, 'idle')
         ON CONFLICT(name) DO UPDATE SET description=excluded.description`,
      )
      .run(name, opts.description ?? null, opts.defaultEnabled === false ? 0 : 1);
    return info.changes > 0;
  }

  setJobEnabled(name: string, enabled: boolean): void {
    this.raw
      .prepare(
        `UPDATE jobs SET enabled=?, status = CASE
            WHEN status='running' THEN 'running'
            WHEN ?=0 THEN 'disabled'
            ELSE 'idle'
          END
          WHERE name=?`,
      )
      .run(enabled ? 1 : 0, enabled ? 1 : 0, name);
  }

  setJobTriggerPending(name: string): void {
    this.raw.prepare(`UPDATE jobs SET trigger_pending=1 WHERE name=?`).run(name);
  }

  clearJobTriggerPending(name: string): void {
    this.raw.prepare(`UPDATE jobs SET trigger_pending=0 WHERE name=?`).run(name);
  }

  getJobState<T = unknown>(name: string): T | null {
    const row = this.raw
      .prepare(`SELECT state_json FROM jobs WHERE name=?`)
      .get(name) as { state_json: string | null } | undefined;
    if (!row?.state_json) return null;
    try { return JSON.parse(row.state_json) as T; } catch { return null; }
  }

  setJobState(name: string, value: unknown): void {
    this.raw
      .prepare(`UPDATE jobs SET state_json=? WHERE name=?`)
      .run(value == null ? null : JSON.stringify(value), name);
  }

  getJob(name: string): JobRow | null {
    const row = this.raw.prepare(`SELECT * FROM jobs WHERE name=?`).get(name) as
      | RawJobRow
      | undefined;
    return row ? toJobRow(row) : null;
  }

  listJobs(): JobRow[] {
    const rows = this.raw.prepare(`SELECT * FROM jobs ORDER BY name`).all() as RawJobRow[];
    return rows.map(toJobRow);
  }

  /** Begin a job run. Marks the job 'running' and returns the new run id. */
  startJobRun(name: string, triggerKind: JobTriggerKind): number {
    const now = new Date().toISOString();
    const result = this.raw
      .prepare(
        `INSERT INTO job_runs(job_name, trigger_kind, started_at) VALUES(?, ?, ?)`,
      )
      .run(name, triggerKind, now);
    const runId = Number(result.lastInsertRowid);
    this.raw
      .prepare(
        `UPDATE jobs SET status='running', current_run_id=?, last_started_at=?
            WHERE name=?`,
      )
      .run(runId, now, name);
    return runId;
  }

  /** End a job run. Updates last_* fields on the job. */
  endJobRun(
    runId: number,
    result: JobResult,
    opts: { message?: string; error?: string; metrics?: Record<string, number> } = {},
  ): void {
    const now = new Date().toISOString();
    const metricsJson = opts.metrics ? JSON.stringify(opts.metrics) : null;
    this.raw
      .prepare(
        `UPDATE job_runs SET ended_at=?, result=?, message=?, error=?, metrics_json=?
            WHERE id=?`,
      )
      .run(now, result, opts.message ?? null, opts.error ?? null, metricsJson, runId);

    const jobRow = this.raw
      .prepare(`SELECT job_name FROM job_runs WHERE id=?`)
      .get(runId) as { job_name: string } | undefined;
    if (!jobRow) return;
    this.raw
      .prepare(
        `UPDATE jobs SET
            status = CASE WHEN enabled=1 THEN 'idle' ELSE 'disabled' END,
            current_run_id = NULL,
            last_ended_at = ?,
            last_result = ?,
            last_error = ?,
            last_message = ?,
            last_metrics_json = ?
          WHERE name = ?`,
      )
      .run(now, result, opts.error ?? null, opts.message ?? null, metricsJson, jobRow.job_name);
  }

  /** Return the N most-recent runs for a job (newest first). */
  listJobRuns(name: string, limit = 10): JobRunRow[] {
    const rows = this.raw
      .prepare(
        `SELECT * FROM job_runs WHERE job_name=? ORDER BY id DESC LIMIT ?`,
      )
      .all(name, limit) as RawJobRunRow[];
    return rows.map(toJobRunRow);
  }

  /**
   * Return the N most-recent runs across ALL jobs (newest first).
   * Used by the UI's Runs tab.
   */
  listAllJobRuns(limit = 100): JobRunRow[] {
    const rows = this.raw
      .prepare(`SELECT * FROM job_runs ORDER BY id DESC LIMIT ?`)
      .all(limit) as RawJobRunRow[];
    return rows.map(toJobRunRow);
  }

  /** Fetch a single run by id. */
  getJobRun(runId: number): JobRunRow | null {
    const row = this.raw
      .prepare(`SELECT * FROM job_runs WHERE id = ?`)
      .get(runId) as RawJobRunRow | undefined;
    return row ? toJobRunRow(row) : null;
  }

  /**
   * Clear any 'running' status left over from an unclean shutdown. Should be
   * called once at scheduler startup before reconciliation.
   */
  clearStaleRunning(): number {
    const now = new Date().toISOString();
    const orphans = this.raw
      .prepare(`SELECT id FROM job_runs WHERE ended_at IS NULL`)
      .all() as { id: number }[];
    for (const { id } of orphans) {
      this.raw
        .prepare(`UPDATE job_runs SET ended_at=?, result='cancelled', error='process exited' WHERE id=?`)
        .run(now, id);
    }
    const info = this.raw
      .prepare(
        `UPDATE jobs SET status = CASE WHEN enabled=1 THEN 'idle' ELSE 'disabled' END,
                          current_run_id = NULL
          WHERE status='running'`,
      )
      .run();
    return info.changes;
  }

  close(): void {
    this.raw.close();
  }
}

// ── Job row helpers ──────────────────────────────────────────────────────────

interface RawJobRow {
  name: string;
  description: string | null;
  enabled: number;
  status: string;
  current_run_id: number | null;
  last_started_at: string | null;
  last_ended_at: string | null;
  last_result: string | null;
  last_error: string | null;
  last_message: string | null;
  last_metrics_json: string | null;
  trigger_pending: number;
  state_json: string | null;
}

function toJobRow(r: RawJobRow): JobRow {
  let metrics: Record<string, number> | null = null;
  if (r.last_metrics_json) {
    try { metrics = JSON.parse(r.last_metrics_json) as Record<string, number>; } catch { /* leave null */ }
  }
  let state: unknown | null = null;
  if (r.state_json) {
    try { state = JSON.parse(r.state_json); } catch { /* leave null */ }
  }
  return {
    name: r.name,
    description: r.description,
    enabled: r.enabled === 1,
    status: r.status as JobStatus,
    currentRunId: r.current_run_id,
    lastStartedAt: r.last_started_at,
    lastEndedAt: r.last_ended_at,
    lastResult: r.last_result as JobResult | null,
    lastError: r.last_error,
    lastMessage: r.last_message,
    lastMetrics: metrics,
    triggerPending: r.trigger_pending === 1,
    state,
  };
}

interface RawJobRunRow {
  id: number;
  job_name: string;
  trigger_kind: string;
  started_at: string;
  ended_at: string | null;
  result: string | null;
  message: string | null;
  error: string | null;
  metrics_json: string | null;
}

function toJobRunRow(r: RawJobRunRow): JobRunRow {
  let metrics: Record<string, number> | null = null;
  if (r.metrics_json) {
    try { metrics = JSON.parse(r.metrics_json) as Record<string, number>; } catch { /* leave null */ }
  }
  return {
    id: r.id,
    jobName: r.job_name,
    triggerKind: r.trigger_kind as JobTriggerKind,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    result: r.result as JobResult | null,
    message: r.message,
    error: r.error,
    metrics,
  };
}

/**
 * Short human-readable name for a Type variant — used in error messages
 * when listing the union arms an OrType tried.
 */
function typeKindLabel(t: Type): string {
  switch (t.kind) {
    case 'SymbolType':   return 'Symbol';
    case 'MeaningType':  return 'Meaning';
    case 'ListType':     return `List<${typeKindLabel(t.itemType)}>`;
    case 'MapType':      return 'Map';
    case 'RefType':      return t.name;
    case 'OrType':       return `Or<${t.variants.map(typeKindLabel).join(' | ')}>`;
    case 'OptionalType': return `Optional<${typeKindLabel(t.inner)}>`;
  }
}
