/**
 * Insert or patch typed nodes in the knowledge graph.
 *
 * Input format mirrors `formatDeepNode` output:
 *   { "$type": "Decision", "$id"?: "uuid", field1: "value", field2: ["a","b"] }
 */

import type { Db, InsertResult } from '@coffeectx/core';

export const description = `Insert or patch typed nodes in the knowledge graph.

Each entry is a plain JSON object in the same format that \`get_node_by_id\` and \`raw_query\` return:
  - \`$type\` (required) — named MapType to validate against
  - \`$id\`   (optional) — UUID of an existing node to patch instead of creating new
  - other keys — field values (string for Symbol/Meaning fields, string[] for List fields)

Omit \`$id\` to create a new node (all required fields must be present).
Provide \`$id\` to patch an existing node — only absent fields are added; existing keys are left untouched.

Embeddings for Meaning fields are computed automatically.
Cross-references within the batch: use \`{ "$ref": N }\` as a value, where N is the 0-based index of another entry.

Returns node IDs and per-field errors. Errors include the full list of available field names so you can correct and retry.

Examples:
  Create a new Decision:
    { "$type": "Decision", "title": "Use SQLite", "rationale": "Simple, embedded, no server needed" }

  Patch an existing node with missing fields:
    { "$type": "Decision", "$id": "a3f2...", "context": "Chosen after evaluating Postgres and DynamoDB" }

  Batch with a cross-reference (entry 1 references entry 0):
    [
      { "$type": "File", "path": "src/db.ts" },
      { "$type": "FunctionDef", "name": "insertNode", "file": { "$ref": 0 } }
    ]`;

export interface ParseError {
  index: number;
  message: string;
}

export interface InsertEntryDTO {
  $type: string;
  $id?: string;
  /** Override the auto-set created_at. Accepts either an ISO-8601 string
   *  or a numeric Unix-millisecond value. */
  $created_at?: string | number;
  /** Same shape as `$created_at`. Ignored on inserts unless the caller
   *  wants to backdate; on patches, overrides the automatic bump. */
  $updated_at?: string | number;
  [key: string]: unknown;
}

interface NormalizedEntry {
  type: string;
  id?: string;
  data: Record<string, unknown>;
  createdAt?: number;
  updatedAt?: number;
}

/** Coerce an ISO-8601 string or numeric ms value to Unix milliseconds.
 *  Returns null when the input is unset / undefined; throws on garbage. */
function parseTimestamp(raw: unknown, field: string, index: number): number | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw < 0) {
      throw new Error(`Entry[${index}] "${field}" must be a non-negative ms value, got ${raw}`);
    }
    return Math.floor(raw);
  }
  if (typeof raw === 'string') {
    const ms = Date.parse(raw);
    if (Number.isNaN(ms)) {
      throw new Error(`Entry[${index}] "${field}" is not a valid ISO-8601 string: ${JSON.stringify(raw)}`);
    }
    return ms;
  }
  throw new Error(`Entry[${index}] "${field}" must be an ISO string or ms number, got ${typeof raw}`);
}

/** Parse the flat DTO format into the InsertEntry shape Db expects. */
export function parseEntries(raw: unknown[]): { entries: NormalizedEntry[]; errors: ParseError[] } {
  const entries: NormalizedEntry[] = [];
  const errors: ParseError[] = [];

  for (let i = 0; i < raw.length; i++) {
    const r = raw[i];
    if (!r || typeof r !== 'object' || Array.isArray(r)) {
      errors.push({ index: i, message: `Entry[${i}] must be a JSON object` });
      entries.push({ type: '', data: {} });
      continue;
    }
    const obj = r as Record<string, unknown>;
    const $type = obj['$type'];
    if (typeof $type !== 'string' || $type === '') {
      errors.push({ index: i, message: `Entry[${i}] missing required "$type" field` });
      entries.push({ type: '', data: {} });
      continue;
    }
    const $id = obj['$id'];
    if ($id !== undefined && typeof $id !== 'string') {
      errors.push({ index: i, message: `Entry[${i}] "$id" must be a string` });
      entries.push({ type: '', data: {} });
      continue;
    }
    let createdAt: number | null = null;
    let updatedAt: number | null = null;
    try {
      createdAt = parseTimestamp(obj['$created_at'], '$created_at', i);
      updatedAt = parseTimestamp(obj['$updated_at'], '$updated_at', i);
    } catch (err) {
      errors.push({ index: i, message: (err as Error).message });
      entries.push({ type: '', data: {} });
      continue;
    }
    const data: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k === '$type' || k === '$id' || k === '$created_at' || k === '$updated_at') continue;
      data[k] = v;
    }
    entries.push({
      type: $type,
      id: $id as string | undefined,
      data,
      ...(createdAt != null ? { createdAt } : {}),
      ...(updatedAt != null ? { updatedAt } : {}),
    });
  }

  return { entries, errors };
}

export interface Params {
  entries: InsertEntryDTO[];
}

export interface UpsertResponse {
  parseErrors?: ParseError[];
  result?: InsertResult;
}

export async function run(db: Db, p: Params): Promise<UpsertResponse> {
  const { entries, errors } = parseEntries(p.entries);
  if (errors.length > 0) return { parseErrors: errors };
  const result = await db.insertEntries(entries);
  return { result };
}
