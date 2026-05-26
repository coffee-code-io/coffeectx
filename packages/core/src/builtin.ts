/**
 * Built-in type system: YAML → SQLite sync.
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
 * Leaf shorthands:
 *   "Symbol"    → SymbolType
 *   "Meaning"   → MeaningType
 *   "OtherName" → reference to another named type
 *
 * Skills used to live alongside types in a `skills:` block. They've moved
 * to `~/.coffeecode/skills/<name>/SKILL.md` (front-matter format); the
 * legacy block is parsed but ignored with a one-line warning here.
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
  | { kind: 'Optional'; item: YamlTypeSpec };

/** A named type entry — spec plus optional human-readable description. */
export interface YamlNamedTypeEntry {
  description?: string;
  hidden?: boolean;
  /**
   * Opt the type into versioning. When true, `upsertEntries` accepts the
   * tool-level `bumpVersion` / `delete` flags for nodes of this type —
   * a bump creates a new node row sharing `timeline_id` with the prior
   * version (`version + 1`), and a delete tombstones the current row.
   * Non-`withHistory` types stay single-version forever.
   */
  withHistory?: boolean;
  /**
   * Ordered state machine for this type. Defaults to `['ready']` when absent.
   * The last element is the final (immutable) state — upserts on a node at
   * that state throw unless they explicitly bump $state.
   */
  states?: string[];
  spec: YamlTypeSpec;
}

export interface YamlTypeFile {
  types?: Record<string, unknown>; // raw — parsed via extractTypeEntry
  /** @deprecated Pre-skills-refactor; ignored at load time. */
  skills?: unknown;
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
  const { description, hidden, withHistory, states, ...rest } = obj;
  let parsedStates: string[] | undefined;
  if (Array.isArray(states) && states.every(s => typeof s === 'string') && states.length > 0) {
    parsedStates = states as string[];
  }
  return {
    description: typeof description === 'string' ? description : undefined,
    hidden: hidden === true,
    withHistory: withHistory === true,
    states: parsedStates,
    spec: rest as YamlTypeSpec,
  };
}

// ── Loading ───────────────────────────────────────────────────────────────────

export interface YamlLoadResult {
  types: Map<string, YamlNamedTypeEntry>;
}

export interface YamlDirFilter {
  /** If non-empty, only files whose stem is in this list are loaded. */
  include?: string[];
  /** Stems to skip regardless of include. */
  exclude?: string[];
}

/** Load all *.yaml files from a directory, optionally filtered by filename stem. */
export function loadYamlFromDir(dir: string, filter?: YamlDirFilter): YamlLoadResult {
  const types = new Map<string, YamlNamedTypeEntry>();
  if (!existsSync(dir)) return { types };

  const include = filter?.include && filter.include.length > 0 ? new Set(filter.include) : null;
  const exclude = filter?.exclude && filter.exclude.length > 0 ? new Set(filter.exclude) : null;

  const files = readdirSync(dir)
    .filter(f => extname(f) === '.yaml' || extname(f) === '.yml')
    .filter(f => {
      const stem = f.replace(/\.(yaml|yml)$/, '');
      if (include && !include.has(stem)) return false;
      if (exclude && exclude.has(stem)) return false;
      return true;
    });
  for (const file of files) {
    const content = readFileSync(join(dir, file), 'utf-8');
    const parsed = parseYaml(content) as YamlTypeFile | null;
    if (!parsed) continue;

    for (const [name, raw] of Object.entries(parsed.types ?? {})) {
      types.set(name, extractTypeEntry(raw));
    }
    if (parsed.skills && typeof parsed.skills === 'object') {
      console.warn(
        `[builtin] ${file}: legacy "skills:" block ignored — skills now live under ~/.coffeecode/skills/<name>/SKILL.md`,
      );
    }
  }
  return { types };
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
      assertNotOrOrOptional(inner, `Optional<${spec.slice(0, -1)}>`);
      return { kind: 'OptionalType', inner };
    }
    if (spec === 'Symbol') return { kind: 'SymbolType' };
    if (spec === 'Meaning') return { kind: 'MeaningType' };
    if (!registry.has(spec)) throw new Error(`Unknown type reference: "${spec}"`);
    // Named Or / Optional types are SUGAR — they don't get their own type-graph
    // row. Inline by recursively resolving the inner spec wherever the name
    // appears. Concrete named types (Map, List, atoms) remain RefType refs so
    // the type graph stays small and supports circular definitions.
    const namedSpec = registry.get(spec)!;
    if (isInlineableNamedSpec(namedSpec)) {
      return resolveYamlType(namedSpec, registry);
    }
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
    const variants = spec.types.map(t => resolveYamlType(t, registry));
    for (const v of variants) {
      assertNotOrOrOptional(v, 'Or');
    }
    return { kind: 'OrType', variants };
  }

  if (spec.kind === 'Optional') {
    const inner = resolveYamlType(spec.item, registry);
    assertNotOrOrOptional(inner, 'Optional');
    return { kind: 'OptionalType', inner };
  }

  throw new Error(`Unknown YAML type spec kind: ${JSON.stringify(spec)}`);
}

/** A named type spec qualifies as inline-only iff its top-level kind is Or or Optional. */
function isInlineableNamedSpec(spec: YamlTypeSpec): boolean {
  if (typeof spec === 'string') return spec.endsWith('?');
  return spec.kind === 'Or' || spec.kind === 'Optional';
}

/**
 * Reject direct nesting of Or↔Or, Or↔Optional, Optional↔Or, Optional↔Optional.
 * These shapes are ill-formed because Or and Optional are validation-only
 * constructs — chaining them adds no information and complicates the validator.
 */
function assertNotOrOrOptional(t: Type, context: string): void {
  if (t.kind === 'OrType' || t.kind === 'OptionalType') {
    throw new Error(
      `${context} cannot directly contain ${t.kind === 'OrType' ? 'Or' : 'Optional'} — flatten the variants.`,
    );
  }
}

// ── Sync ──────────────────────────────────────────────────────────────────────

export interface SyncResult {
  types: { synced: string[]; errors: Array<{ name: string; error: string }> };
}

/**
 * Load all YAML definitions from `dir` and upsert types into the DB.
 */
export function syncFromDir(
  db: Db,
  dir: string,
  source: 'builtin' | 'user' = 'user',
  filter?: YamlDirFilter,
): SyncResult {
  const { types: typeRegistry } = loadYamlFromDir(dir, filter);

  // Build a flat spec map for the resolver
  const specRegistry = new Map<string, YamlTypeSpec>();
  for (const [name, entry] of typeRegistry) specRegistry.set(name, entry.spec);

  const typeIdCache = new Map<Type, string>();
  const typesSynced: string[] = [];
  const typesErrors: Array<{ name: string; error: string }> = [];

  for (const [name, entry] of typeRegistry) {
    try {
      // Named Or / Optional types are sugar — they get inlined at every use
      // site by `resolveYamlType`, so there's no `named_types` row to create.
      if (isInlineableNamedSpec(entry.spec)) {
        typesSynced.push(name);
        continue;
      }
      const type = resolveYamlType(entry.spec, specRegistry);
      const typeId = db.upsertType(type, typeIdCache, name);
      db.upsertNamedType(name, typeId, source, entry.description, entry.hidden, entry.withHistory);
      // Sync the state machine. `setStatesForType` wipes any pre-existing
      // rows so removing `states:` from the YAML restores the default
      // `[ready]` behaviour at read time.
      db.setStatesForType(name, entry.states ?? []);
      typesSynced.push(name);
    } catch (err) {
      typesErrors.push({ name, error: (err as Error).message });
    }
  }

  // Remove type rows that are no longer reachable from any named type.
  // This cleans up orphaned rows from previous sync runs.
  db.gcOrphanedTypes();

  return {
    types: { synced: typesSynced, errors: typesErrors },
  };
}

export interface SyncAllTypesOptions {
  /** Filter applied to built-in type files (by filename stem, e.g. "api", "contract"). */
  builtinFilter?: YamlDirFilter;
  /** Directory of user-defined YAML type files. */
  userDir?: string;
  /**
   * Additional YAML files contributed by user skills (via
   * `coffeecode.types: ./types.yaml` in their SKILL.md front-matter).
   * Loaded with `source: 'user'` AFTER the user-dir pass.
   */
  skillTypeFiles?: string[];
}

/** Sync built-in types, then user-dir types, then any skill-contributed type files. */
export function syncAllTypes(db: Db, userDirOrOptions?: string | SyncAllTypesOptions): SyncResult {
  const opts: SyncAllTypesOptions =
    typeof userDirOrOptions === 'string'
      ? { userDir: userDirOrOptions }
      : (userDirOrOptions ?? {});

  const merged: SyncResult = {
    types: { synced: [], errors: [] },
  };
  const append = (r: SyncResult) => {
    merged.types.synced.push(...r.types.synced);
    merged.types.errors.push(...r.types.errors);
  };

  append(syncFromDir(db, builtinTypesDir(), 'builtin', opts.builtinFilter));
  if (opts.userDir) append(syncFromDir(db, opts.userDir, 'user'));
  for (const file of opts.skillTypeFiles ?? []) {
    append(syncFromFile(db, file, 'user'));
  }
  return merged;
}

/**
 * Load a single YAML file's `types:` block and upsert into the DB. Used for
 * per-skill type contributions (where the YAML lives next to the skill, not
 * inside the user types dir).
 */
export function syncFromFile(db: Db, filePath: string, source: 'builtin' | 'user' = 'user'): SyncResult {
  if (!existsSync(filePath)) {
    return { types: { synced: [], errors: [{ name: filePath, error: 'file not found' }] } };
  }
  const content = readFileSync(filePath, 'utf-8');
  const parsed = (parseYaml(content) as YamlTypeFile | null) ?? {};

  const typeRegistry = new Map<string, YamlNamedTypeEntry>();
  for (const [name, raw] of Object.entries(parsed.types ?? {})) {
    typeRegistry.set(name, extractTypeEntry(raw));
  }
  if (parsed.skills && typeof parsed.skills === 'object') {
    console.warn(
      `[builtin] ${filePath}: legacy "skills:" block ignored — declare \`coffeecode.job\` in SKILL.md instead`,
    );
  }

  const specRegistry = new Map<string, YamlTypeSpec>();
  for (const [name, entry] of typeRegistry) specRegistry.set(name, entry.spec);

  const typeIdCache = new Map<Type, string>();
  const typesSynced: string[] = [];
  const typesErrors: Array<{ name: string; error: string }> = [];

  for (const [name, entry] of typeRegistry) {
    try {
      if (isInlineableNamedSpec(entry.spec)) { typesSynced.push(name); continue; }
      const type = resolveYamlType(entry.spec, specRegistry);
      const typeId = db.upsertType(type, typeIdCache, name);
      db.upsertNamedType(name, typeId, source, entry.description, entry.hidden, entry.withHistory);
      db.setStatesForType(name, entry.states ?? []);
      typesSynced.push(name);
    } catch (err) {
      typesErrors.push({ name, error: (err as Error).message });
    }
  }

  db.gcOrphanedTypes();
  return { types: { synced: typesSynced, errors: typesErrors } };
}

/** @deprecated Alias for syncFromDir — kept for backwards compat. */
export function syncTypesFromDir(
  db: Db,
  dir: string,
  source: 'builtin' | 'user' = 'user',
): SyncResult {
  return syncFromDir(db, dir, source);
}
