/**
 * Session-scoped cache for named type lookups and shallow type loading.
 *
 * Use in operations that insert many nodes (e.g. LSP indexing) to avoid
 * repeated DB queries for the same named types across thousands of insertions.
 *
 * Loads types shallowly (RefType nodes are NOT resolved) so that types passed
 * back to Db.upsertType produce the same content_key as the originally-stored
 * rows — enabling correct deduplication and ensuring inserted map nodes carry
 * the same type_id that named_types points to.
 */

import type { Db } from './db.js';
import type { Type } from './types.js';

export class TypeCache {
  private readonly db: Db;
  /** name → typeId (null if not found) */
  private readonly nameToId = new Map<string, string | null>();
  /**
   * typeId → shallow Type.
   * Also passed directly to Db.loadTypeShallow so it acts as the load cache,
   * preventing duplicate loads for shared structural types (SymbolType, etc.).
   */
  private readonly idToType = new Map<string, Type>();

  constructor(db: Db) {
    this.db = db;
  }

  /** Return the type_id for a named type, or null if it does not exist. */
  getTypeId(name: string): string | null {
    if (this.nameToId.has(name)) return this.nameToId.get(name)!;
    const entry = this.db.loadNamedType(name);
    const id = entry?.typeId ?? null;
    this.nameToId.set(name, id);
    return id;
  }

  /**
   * Return the shallow Type for a named type (RefType nodes not resolved).
   * Returns null if the named type does not exist.
   */
  getType(name: string): Type | null {
    const id = this.getTypeId(name);
    if (!id) return null;
    return this.getTypeById(id);
  }

  /** Return the shallow Type for an arbitrary type_id. */
  getTypeById(typeId: string): Type {
    if (this.idToType.has(typeId)) return this.idToType.get(typeId)!;
    // Pass idToType as the load cache — loadTypeShallow will populate it
    // for all types it visits, so repeated calls share the same objects.
    return this.db.loadTypeShallow(typeId, this.idToType);
  }
}
