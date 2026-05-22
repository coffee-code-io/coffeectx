import type Database from 'better-sqlite3';

/**
 * Materialized edge index between named-type nodes.
 *
 * For any named-type root R and any named-type descendant D found in R's
 * subtree, we record one row `(R.id, D.id, field_path, R.type, D.type)`. The
 * `field_path` is the dotted sequence of map keys from R to D, with list
 * indices suppressed (so `relatedSymbols` rather than `relatedSymbols.0`).
 *
 * When a deep tree has nested named-type ancestors (e.g. an LspFunction whose
 * `location.file` field is a File node), we emit edges from every named-type
 * ancestor along the path, not just from the top-level root. This matches the
 * semantics of the previous recursive-CTE-based `findReferencingNamedNodes`
 * and `collectOutgoingNamedRefs` implementations.
 *
 * All inserts use `INSERT OR IGNORE` so repeated population is idempotent.
 */

interface MapRow { key: string; value_id: string }
interface ListRow { item_id: string }
interface NamedRow { name: string }

/** Walk every named-type node in the DB and rebuild the entire index. */
export function rebuildNodeRefs(raw: Database.Database): { rows: number } {
  raw.exec('DELETE FROM node_refs');
  const insert = raw.prepare(
    `INSERT OR IGNORE INTO node_refs(src_id, dst_id, field_path, src_type, dst_type)
     VALUES(?,?,?,?,?)`,
  );

  const roots = raw
    .prepare(
      `SELECT n.id AS id, nt.name AS typeName
       FROM nodes n JOIN named_types nt ON nt.type_id = n.type_id`,
    )
    .all() as Array<{ id: string; typeName: string }>;

  let rows = 0;
  const txn = raw.transaction(() => {
    for (const root of roots) {
      rows += populateForRoot(raw, insert, root.id, root.typeName);
    }
  });
  txn();
  return { rows };
}

/**
 * Populate node_refs for a set of recently-inserted/patched root node IDs.
 * Each root's subtree is walked once.
 */
export function populateNodeRefsFor(
  raw: Database.Database,
  rootIds: string[],
): void {
  if (rootIds.length === 0) return;
  const insert = raw.prepare(
    `INSERT OR IGNORE INTO node_refs(src_id, dst_id, field_path, src_type, dst_type)
     VALUES(?,?,?,?,?)`,
  );
  const namedFor = raw.prepare(
    `SELECT nt.name FROM nodes n JOIN named_types nt ON nt.type_id = n.type_id WHERE n.id = ?`,
  );

  for (const rootId of rootIds) {
    const row = namedFor.get(rootId) as NamedRow | undefined;
    if (!row) continue;
    populateForRoot(raw, insert, rootId, row.name);
  }
}

interface NamedAncestor { id: string; typeName: string; basePath: string }

/**
 * Walk the subtree rooted at `rootId` once. For every named-type node N
 * encountered, emit one edge from every named ancestor (incl. the root) to N.
 * Returns the number of edge inserts attempted.
 */
function populateForRoot(
  raw: Database.Database,
  insert: Database.Statement,
  rootId: string,
  rootTypeName: string,
): number {
  const mapStmt = raw.prepare(`SELECT key, value_id FROM map_entries WHERE map_id = ?`);
  const listStmt = raw.prepare(`SELECT item_id FROM list_items WHERE list_id = ?`);
  const namedStmt = raw.prepare(
    `SELECT nt.name FROM nodes n JOIN named_types nt ON nt.type_id = n.type_id WHERE n.id = ?`,
  );

  let count = 0;
  const visit = (
    nodeId: string,
    pathFromRoot: string,
    ancestors: NamedAncestor[],
    depth: number,
  ): void => {
    if (depth > 20) return; // safety against cycles

    const mapRows = mapStmt.all(nodeId) as MapRow[];
    for (const r of mapRows) {
      const childPath = pathFromRoot === '' ? r.key : `${pathFromRoot}.${r.key}`;
      const named = namedStmt.get(r.value_id) as NamedRow | undefined;
      if (named) {
        for (const a of ancestors) {
          if (a.id === r.value_id) continue;
          const rel = childPath.startsWith(a.basePath)
            ? childPath.slice(a.basePath.length).replace(/^\./, '')
            : childPath;
          insert.run(a.id, r.value_id, rel, a.typeName, named.name);
          count++;
        }
        visit(
          r.value_id,
          childPath,
          [...ancestors, { id: r.value_id, typeName: named.name, basePath: childPath }],
          depth + 1,
        );
      } else {
        visit(r.value_id, childPath, ancestors, depth + 1);
      }
    }

    const listRows = listStmt.all(nodeId) as ListRow[];
    for (const r of listRows) {
      const named = namedStmt.get(r.item_id) as NamedRow | undefined;
      if (named) {
        for (const a of ancestors) {
          if (a.id === r.item_id) continue;
          const rel = pathFromRoot.startsWith(a.basePath)
            ? pathFromRoot.slice(a.basePath.length).replace(/^\./, '')
            : pathFromRoot;
          insert.run(a.id, r.item_id, rel, a.typeName, named.name);
          count++;
        }
        visit(
          r.item_id,
          pathFromRoot,
          [...ancestors, { id: r.item_id, typeName: named.name, basePath: pathFromRoot }],
          depth + 1,
        );
      } else {
        visit(r.item_id, pathFromRoot, ancestors, depth + 1);
      }
    }
  };

  visit(rootId, '', [{ id: rootId, typeName: rootTypeName, basePath: '' }], 0);
  return count;
}

/** Remove all rows touching `nodeId`. Called when a node is deleted. */
export function deleteNodeRefs(raw: Database.Database, nodeId: string): void {
  raw.prepare(`DELETE FROM node_refs WHERE src_id = ? OR dst_id = ?`).run(nodeId, nodeId);
}
