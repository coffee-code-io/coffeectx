/**
 * Built-in type + skill system: YAML → SQLite sync.
 *
 * YAML file format:
 *
 *   types:
 *     TypeName:
 *       description: "Human-readable description of this type"   # optional
 *       kind: Map
 *       fields:
 *         fieldName: Symbol           # or Meaning or OtherTypeName (reference)
 *         listField:
 *           kind: List
 *           item: Symbol
 *         orField:
 *           kind: Or
 *           types: [Symbol, Meaning]
 *
 *   skills:
 *     SkillName:
 *       description: "One-line summary"
 *       prompt: |
 *         Multi-line prompt explaining how to extract these types ...
 *       types: [TypeA, TypeB, ...]   # references to named types
 *
 * Leaf shorthands:
 *   "Symbol"    → SymbolType
 *   "Meaning"   → MeaningType
 *   "OtherName" → reference to another named type
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import type { Type } from './types.js';
import type { Db } from './db.js';

// ── YAML spec types ───────────────────────────────────────────────────────────

/** The structural part of a type spec (no description here). */
export type YamlTypeSpec =
  | string // "Symbol" | "Meaning" | "TypeName" (ref); append "?" for Optional, e.g. "Meaning?"
  | { kind: 'Map'; fields: Record<string, YamlTypeSpec> }
  | { kind: 'List'; item: YamlTypeSpec }
  | { kind: 'Or'; types: YamlTypeSpec[] }
  | { kind: 'And'; types: YamlTypeSpec[] }
  | { kind: 'Optional'; item: YamlTypeSpec };

/** A named type entry — spec plus optional human-readable description. */
export interface YamlNamedTypeEntry {
  description?: string;
  hidden?: boolean;
  spec: YamlTypeSpec;
}

/** A skill entry in YAML. */
export interface YamlSkillEntry {
  description?: string;
  prompt: string;
  types: string[]; // references to named types
}

export interface YamlTypeFile {
  types?: Record<string, unknown>; // raw — parsed via extractTypeEntry
  skills?: Record<string, YamlSkillEntry>;
}

// ── Parsing helpers ───────────────────────────────────────────────────────────

/**
 * Split a raw YAML value into an optional description and the structural spec.
 * Handles both:
 *   - Plain string shorthand: "Symbol" / "Meaning" / "Ref"
 *   - Object with optional 'description' key alongside kind/fields/item/types
 */
function extractTypeEntry(raw: unknown): YamlNamedTypeEntry {
  if (typeof raw === 'string') return { spec: raw };

  const obj = raw as Record<string, unknown>;
  const { description, hidden, ...rest } = obj;
  return {
    description: typeof description === 'string' ? description : undefined,
    hidden: hidden === true,
    spec: rest as YamlTypeSpec,
  };
}

// ── Loading ───────────────────────────────────────────────────────────────────

export interface YamlLoadResult {
  types: Map<string, YamlNamedTypeEntry>;
  skills: Map<string, YamlSkillEntry>;
}

/** Load all *.yaml files from a directory. */
export function loadYamlFromDir(dir: string): YamlLoadResult {
  const types = new Map<string, YamlNamedTypeEntry>();
  const skills = new Map<string, YamlSkillEntry>();
  if (!existsSync(dir)) return { types, skills };

  const files = readdirSync(dir).filter(f => extname(f) === '.yaml' || extname(f) === '.yml');
  for (const file of files) {
    const content = readFileSync(join(dir, file), 'utf-8');
    const parsed = parseYaml(content) as YamlTypeFile | null;
    if (!parsed) continue;

    for (const [name, raw] of Object.entries(parsed.types ?? {})) {
      types.set(name, extractTypeEntry(raw));
    }
    for (const [name, raw] of Object.entries(parsed.skills ?? {})) {
      skills.set(name, raw as YamlSkillEntry);
    }
  }
  return { types, skills };
}

/** @deprecated Use loadYamlFromDir; kept for callers that only need the spec map. */
export function loadYamlTypesFromDir(dir: string): Map<string, YamlTypeSpec> {
  const { types } = loadYamlFromDir(dir);
  const out = new Map<string, YamlTypeSpec>();
  for (const [name, entry] of types) out.set(name, entry.spec);
  return out;
}

/** Path to the built-in types shipped with this package. */
export function builtinTypesDir(): string {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  return join(__dirname, '..', 'builtin-types');
}

// ── Resolution ────────────────────────────────────────────────────────────────

/**
 * Resolve a YamlTypeSpec into a Type.
 *
 * Named type references (strings other than "Symbol"/"Meaning") become RefType
 * nodes rather than being inlined recursively.  This gives O(types) DB rows
 * instead of O(types^depth) and naturally supports circular type definitions
 * (A.field: B, B.field: A).
 *
 * The registry is used only to validate that the referenced name exists.
 */
export function resolveYamlType(
  spec: YamlTypeSpec,
  registry: Map<string, YamlTypeSpec>,
): Type {
  if (typeof spec === 'string') {
    // "?" suffix — Optional wrapper shorthand: "Meaning?" | "Symbol?" | "TypeName?"
    if (spec.endsWith('?')) {
      const inner = resolveYamlType(spec.slice(0, -1) as YamlTypeSpec, registry);
      return { kind: 'OptionalType', inner };
    }
    if (spec === 'Symbol') return { kind: 'SymbolType' };
    if (spec === 'Meaning') return { kind: 'MeaningType' };
    if (!registry.has(spec)) throw new Error(`Unknown type reference: "${spec}"`);
    // Lightweight reference — the DB deduplicates RefType rows by name.
    return { kind: 'RefType', name: spec };
  }

  if (spec.kind === 'Map') {
    const entries: Record<string, Type> = {};
    for (const [key, val] of Object.entries(spec.fields)) {
      entries[key] = resolveYamlType(val, registry);
    }
    return { kind: 'MapType', entries };
  }

  if (spec.kind === 'List') {
    return { kind: 'ListType', itemType: resolveYamlType(spec.item, registry) };
  }

  if (spec.kind === 'Or') {
    if (spec.types.length < 2) throw new Error('Or requires at least 2 types');
    let result = resolveYamlType(spec.types[0]!, registry);
    for (let i = 1; i < spec.types.length; i++) {
      result = { kind: 'OrType', left: result, right: resolveYamlType(spec.types[i]!, registry) };
    }
    return result;
  }

  if (spec.kind === 'And') {
    if (spec.types.length < 2) throw new Error('And requires at least 2 types');
    let result = resolveYamlType(spec.types[0]!, registry);
    for (let i = 1; i < spec.types.length; i++) {
      result = { kind: 'AndType', left: result, right: resolveYamlType(spec.types[i]!, registry) };
    }
    return result;
  }

  if (spec.kind === 'Optional') {
    return { kind: 'OptionalType', inner: resolveYamlType(spec.item, registry) };
  }

  throw new Error(`Unknown YAML type spec kind: ${JSON.stringify(spec)}`);
}

// ── Sync ──────────────────────────────────────────────────────────────────────

export interface SyncResult {
  types: { synced: string[]; errors: Array<{ name: string; error: string }> };
  skills: { synced: string[]; errors: Array<{ name: string; error: string }> };
}

/**
 * Load all YAML definitions from `dir` and upsert types + skills into the DB.
 */
export function syncFromDir(
  db: Db,
  dir: string,
  source: 'builtin' | 'user' = 'user',
): SyncResult {
  const { types: typeRegistry, skills: skillRegistry } = loadYamlFromDir(dir);

  // Build a flat spec map for the resolver
  const specRegistry = new Map<string, YamlTypeSpec>();
  for (const [name, entry] of typeRegistry) specRegistry.set(name, entry.spec);

  const typeIdCache = new Map<Type, string>();
  const typesSynced: string[] = [];
  const typesErrors: Array<{ name: string; error: string }> = [];

  for (const [name, entry] of typeRegistry) {
    try {
      const type = resolveYamlType(entry.spec, specRegistry);
      const typeId = db.upsertType(type, typeIdCache);
      db.upsertNamedType(name, typeId, source, entry.description, entry.hidden);
      typesSynced.push(name);
    } catch (err) {
      typesErrors.push({ name, error: (err as Error).message });
    }
  }

  const skillsSynced: string[] = [];
  const skillsErrors: Array<{ name: string; error: string }> = [];

  for (const [name, skill] of skillRegistry) {
    try {
      db.upsertSkill(name, skill.prompt, source, skill.description, skill.types);
      skillsSynced.push(name);
    } catch (err) {
      skillsErrors.push({ name, error: (err as Error).message });
    }
  }

  // Remove type rows that are no longer reachable from any named type.
  // This cleans up orphaned rows from previous sync runs.
  db.gcOrphanedTypes();

  return {
    types: { synced: typesSynced, errors: typesErrors },
    skills: { synced: skillsSynced, errors: skillsErrors },
  };
}

/** Sync built-in types + skills, then optionally user-defined ones. */
export function syncAllTypes(db: Db, userDir?: string): SyncResult {
  const builtin = syncFromDir(db, builtinTypesDir(), 'builtin');
  if (!userDir) return builtin;

  const user = syncFromDir(db, userDir, 'user');
  return {
    types: {
      synced: [...builtin.types.synced, ...user.types.synced],
      errors: [...builtin.types.errors, ...user.types.errors],
    },
    skills: {
      synced: [...builtin.skills.synced, ...user.skills.synced],
      errors: [...builtin.skills.errors, ...user.skills.errors],
    },
  };
}

/** @deprecated Alias for syncFromDir — kept for backwards compat. */
export function syncTypesFromDir(
  db: Db,
  dir: string,
  source: 'builtin' | 'user' = 'user',
): SyncResult {
  return syncFromDir(db, dir, source);
}
