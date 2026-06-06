/**
 * Lazy per-project Db handle cache for the UI server.
 *
 * Each project has its own SQLite file; the server opens one Db per project on
 * first request and keeps it alive for the lifetime of the server process.
 * Closed on process exit via `closeAll()` registered against SIGINT/SIGTERM.
 */

import { Db, loadConfig, createEmbedFn, resolveProjectEmbed } from '@coffeectx/core';
import type { CoffeectxConfig } from '@coffeectx/core';

interface PoolEntry {
  db: Db;
  embedDims: number;
}

const pool = new Map<string, PoolEntry>();

/**
 * Get a Db handle for the given project. Throws if the project doesn't exist.
 * Re-uses an existing handle when one is already open.
 */
export function getDb(projectName: string, config?: CoffeectxConfig): Db {
  const cached = pool.get(projectName);
  if (cached) return cached.db;

  const cfg = config ?? loadConfig();
  const project = cfg.projects[projectName];
  if (!project) throw new Error(`unknown project "${projectName}"`);

  const embed = resolveProjectEmbed(cfg, projectName);
  const embedFn = createEmbedFn(embed);
  const db = new Db({ path: project.db, embed: embedFn, dimensions: embed.dimensions, debug: cfg.debug });
  pool.set(projectName, { db, embedDims: embed.dimensions ?? 128 });
  return db;
}

/** Close every open handle. Idempotent. */
export function closeAll(): void {
  for (const [name, entry] of pool) {
    try { entry.db.close(); }
    catch { /* ignore close errors during shutdown */ }
    pool.delete(name);
  }
}

/**
 * Close the cached Db handle for one project and drop it from the pool.
 * The next `getDb(project)` call opens a fresh connection — useful after
 * an external `restore` / `reset` swap of the SQLite file on disk where
 * the held connection would otherwise keep serving stale rows from the
 * pre-swap WAL/shm pair.
 */
export function invalidate(projectName: string): boolean {
  const entry = pool.get(projectName);
  if (!entry) return false;
  try { entry.db.close(); }
  catch { /* swallow — the file may already be gone */ }
  pool.delete(projectName);
  return true;
}
