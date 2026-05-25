/**
 * Resolve a user job's `allowed-tools` allowlist into the two concrete
 * lists pi's session API expects:
 *
 *   - `customTools`: the subset of our graph tools whose names pass the
 *     allowlist (so we only register what's allowed).
 *   - `tools`:       the full union of (allowed customTools ∪ allowed pi
 *     builtins ∪ allowed extension tools). Pi's `tools` arg is an exact
 *     name allowlist; this is the resolved, glob-expanded version.
 *
 * Glob syntax: shell-style with `*` (zero or more chars) and `?` (single
 * char). No `[]` ranges, no `**`. Tool names today are flat snake_case so
 * the simple matcher covers every realistic pattern (`mcp__*`, `read*`,
 * `*write*`).
 *
 * Default behaviour when the skill omits `allowed-tools` is supplied by
 * the caller (see `defaultUserJobTools`).
 */

import type { ToolDefinition } from '@earendil-works/pi-coding-agent';

/** Tool registry the resolver sees: every tool we COULD register. */
export interface ToolRegistry {
  /** Custom (in-process) tools we built — graph + write_file + secrets. */
  customTools: ToolDefinition[];
  /** Pi-builtin names available to enable via `tools: [...]`. Pi accepts
   *  any string here; unknown names are no-ops, so a too-permissive list
   *  is fine. */
  piBuiltins: ReadonlyArray<string>;
  /** Extension tool names pi resolved before session creation. Pass them
   *  in if you need glob matching against extensions; otherwise omit. */
  extensions?: ReadonlyArray<string>;
}

export interface ResolvedTools {
  /** customTools list, filtered to allowed names. */
  customTools: ToolDefinition[];
  /** Full allowed name list to hand pi as `tools: [...]`. */
  toolNames: string[];
}

/** Default minimum-permissions allowlist for a user job that didn't
 *  declare `allowed-tools`. Names match the customTools the runner builds
 *  with `allowInsert:false, allowFileWrite:false`. */
export const DEFAULT_USER_JOB_TOOLS: ReadonlyArray<string> = [
  'search',
  'get_by_symbol_text',
  'regex',
  'raw_query',
  'get_node_by_id',
  'resolve_symbols',
];

/**
 * Compile a glob to a RegExp anchored at start+end. Only `*` and `?` are
 * treated specially; every other char is escaped so e.g. `mcp__*` matches
 * literal `mcp__` then anything.
 */
function compileGlob(pattern: string): RegExp {
  let body = '';
  for (const ch of pattern) {
    if (ch === '*') body += '.*';
    else if (ch === '?') body += '.';
    else body += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + body + '$');
}

/** True iff any pattern matches `name`. Literal names skip the RegExp. */
function matchesAny(name: string, patterns: ReadonlyArray<string>): boolean {
  for (const p of patterns) {
    if (!p.includes('*') && !p.includes('?')) {
      if (p === name) return true;
      continue;
    }
    if (compileGlob(p).test(name)) return true;
  }
  return false;
}

/**
 * Resolve the effective tool list for a session. `allowed` may include
 * globs; unmatched patterns are silently dropped (we don't warn on
 * unknown tool names because extensions can register more tools than the
 * resolver currently sees).
 */
export function resolveAllowedTools(
  registry: ToolRegistry,
  allowed: ReadonlyArray<string>,
): ResolvedTools {
  const customTools = registry.customTools.filter(t => matchesAny(t.name, allowed));
  const builtinAllowed = registry.piBuiltins.filter(n => matchesAny(n, allowed));
  const extAllowed = (registry.extensions ?? []).filter(n => matchesAny(n, allowed));
  const seen = new Set<string>();
  const toolNames: string[] = [];
  for (const t of customTools) {
    if (seen.has(t.name)) continue;
    seen.add(t.name);
    toolNames.push(t.name);
  }
  for (const n of builtinAllowed) {
    if (seen.has(n)) continue;
    seen.add(n);
    toolNames.push(n);
  }
  for (const n of extAllowed) {
    if (seen.has(n)) continue;
    seen.add(n);
    toolNames.push(n);
  }
  return { customTools, toolNames };
}

/** Pi-builtin tool name registry we permit when a skill opts into FS access.
 *  Mirrors `createReadOnlyTools` / `createCodingTools` shipped by
 *  pi-coding-agent. Listed here so glob patterns like `read*` can resolve
 *  without us having to introspect pi's runtime. */
export const PI_BUILTIN_TOOL_NAMES: ReadonlyArray<string> = [
  // Read-only file inspection
  'read',
  'grep',
  'find',
  'ls',
  // Mutating
  'bash',
  'edit',
  'write',
];
