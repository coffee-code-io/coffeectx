import type { DeepNode } from './types.js';

/**
 * Convert a DeepNode tree to a compact, human-readable plain object.
 *
 * Rules:
 * - Symbol atoms   → bare string value
 * - Meaning atoms  → bare string text (vector omitted)
 * - Lists          → array
 * - Maps           → plain object; `$type` added when typeName is known;
 *                    full Type definition omitted; `kind` fields omitted
 * - Ref nodes      → { $ref: id }
 * - Cycle nodes    → { $cycle: id }
 * - Empty strings, empty objects, and empty arrays are omitted from maps.
 */
export function formatDeepNode(node: DeepNode): unknown {
  switch (node.kind) {
    case 'atom':
      if (node.atom.kind === 'symbol') return node.atom.value;
      return node.atom.value.text; // meaning — text only, no vec

    case 'list':
      return node.items.map(formatDeepNode);

    case 'map': {
      const out: Record<string, unknown> = {};
      if (node.typeName) out['$type'] = node.typeName;
      for (const [key, child] of Object.entries(node.entries)) {
        const v = formatDeepNode(child);
        if (isEmpty(v)) continue;
        out[key] = v;
      }
      return out;
    }

    case 'ref':   return { $id: node.id };
    case 'cycle': return { $id: node.id };
  }
}

function isEmpty(v: unknown): boolean {
  if (v === '' || v === null || v === undefined) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v as object).length === 0;
  return false;
}
