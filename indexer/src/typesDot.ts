import type { Db } from '@coffeectx/core';

function escapeDot(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function typeNodeId(typeId: string): string {
  return `t_${typeId.replace(/[^a-zA-Z0-9_]/g, '_')}`;
}

function namedNodeId(name: string): string {
  return `n_${name.replace(/[^a-zA-Z0-9_]/g, '_')}`;
}

function addEdge(edges: Set<string>, from: string, to: string, label?: string): void {
  const attr = label ? ` [label="${escapeDot(label)}"]` : '';
  edges.add(`  ${from} -> ${to}${attr};`);
}

interface RawDb {
  prepare(sql: string): { all(...args: unknown[]): unknown[]; get(...args: unknown[]): unknown };
}

interface TypeRow {
  id: string;
  kind: string;
  ref_name: string | null;
}

interface TypeChildRow {
  type_id: string;
  position: number;
  child_type_id: string;
}

interface TypeMapEntryRow {
  type_id: string;
  key: string;
  value_type_id: string;
}

/**
 * Build a Graphviz DOT representation of the named type graph.
 *
 * Only renders type nodes that are reachable from a named type entry —
 * orphaned rows (from pre-dedup schema) are excluded.
 * RefType nodes show their target name and connect back to the named type box.
 */
export function generateTypesDot(db: Db, graphName = 'TypesGraph'): string {
  const namedTypes = db.listNamedTypes();
  const raw = (db as unknown as { raw: RawDb }).raw;

  const allTypes = raw.prepare(`SELECT id, kind, ref_name FROM types`).all() as TypeRow[];
  const typeChildren = raw
    .prepare(`SELECT type_id, position, child_type_id FROM type_children`)
    .all() as TypeChildRow[];
  const typeMapEntries = raw
    .prepare(`SELECT type_id, key, value_type_id FROM type_map_entries`)
    .all() as TypeMapEntryRow[];

  // Build lookup maps
  const typeInfo = new Map<string, TypeRow>();
  for (const row of allTypes) typeInfo.set(row.id, row);

  const childrenOf = new Map<string, TypeChildRow[]>();
  for (const row of typeChildren) {
    const list = childrenOf.get(row.type_id) ?? [];
    list.push(row);
    childrenOf.set(row.type_id, list);
  }

  const fieldsOfClean = new Map<string, TypeMapEntryRow[]>();
  for (const row of typeMapEntries) {
    if (!fieldsOfClean.has(row.type_id)) fieldsOfClean.set(row.type_id, []);
    fieldsOfClean.get(row.type_id)!.push(row);
  }

  const namedTypeIdToName = new Map<string, string>();
  for (const { name, typeId } of namedTypes) namedTypeIdToName.set(typeId, name);

  // BFS/DFS from all named type roots to find reachable type IDs
  const reachable = new Set<string>();
  const queue: string[] = namedTypes.map(n => n.typeId);
  for (const id of queue) reachable.add(id);
  while (queue.length) {
    const id = queue.shift()!;
    for (const child of childrenOf.get(id) ?? []) {
      if (!reachable.has(child.child_type_id)) {
        reachable.add(child.child_type_id);
        queue.push(child.child_type_id);
      }
    }
    for (const field of fieldsOfClean.get(id) ?? []) {
      if (!reachable.has(field.value_type_id)) {
        reachable.add(field.value_type_id);
        queue.push(field.value_type_id);
      }
    }
  }

  const lines: string[] = [];
  lines.push(`digraph ${graphName} {`);
  lines.push('  rankdir=LR;');
  lines.push('  node [fontname="Menlo"];');

  // Structural type nodes (reachable only)
  for (const id of reachable) {
    const info = typeInfo.get(id);
    if (!info) continue;
    const nodeId = typeNodeId(id);
    let label: string;
    if (info.kind === 'RefType' && info.ref_name) {
      label = `→ ${info.ref_name}`;
    } else {
      label = info.kind;
    }
    lines.push(`  ${nodeId} [shape=ellipse, label="${escapeDot(label)}"];`);
  }

  // Named type nodes (boxes)
  for (const { name, source } of namedTypes) {
    const nId = namedNodeId(name);
    const label = `${name}\\n[${source}]`;
    lines.push(`  ${nId} [shape=box, style=filled, fillcolor="#e8f1ff", label="${escapeDot(label)}"];`);
  }

  const edges = new Set<string>();

  // named type → its structural root
  for (const { name, typeId } of namedTypes) {
    if (reachable.has(typeId)) addEdge(edges, namedNodeId(name), typeNodeId(typeId));
  }

  // structural children
  for (const row of typeChildren) {
    if (!reachable.has(row.type_id)) continue;
    const label = row.position === 0 ? 'item/left' : 'right';
    addEdge(edges, typeNodeId(row.type_id), typeNodeId(row.child_type_id), label);
  }

  // map fields
  for (const row of typeMapEntries) {
    if (!reachable.has(row.type_id)) continue;
    addEdge(edges, typeNodeId(row.type_id), typeNodeId(row.value_type_id), row.key);
  }

  // RefType → named type box (instead of pointing to the opaque type_id)
  for (const id of reachable) {
    const info = typeInfo.get(id);
    if (info?.kind === 'RefType' && info.ref_name) {
      const targetNamed = namedTypes.find(n => n.name === info.ref_name);
      if (targetNamed) {
        addEdge(edges, typeNodeId(id), namedNodeId(info.ref_name!));
      }
    }
  }

  for (const edge of [...edges].sort()) lines.push(edge);
  lines.push('}');
  lines.push('');

  return lines.join('\n');
}
