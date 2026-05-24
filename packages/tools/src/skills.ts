/**
 * Skill registry tools: list all skills, fetch one by name.
 *
 * Skills are loaded from disk by `@coffeectx/core`'s `loadSkillsFromDir`
 * and passed in here as a plain array — these helpers are pure functions
 * over that registry. The `currentAgent` filter implements the
 * `coffeecode.loadInto:` SKILL.md field, so each agent only sees the
 * skills explicitly opted in for it.
 */

import type { Skill, SkillLoadTarget } from '@coffeectx/core';

export const listDescription =
  'List all skills available to this agent. Each skill is a small markdown ' +
  'document describing a focused task (e.g. extract decisions from logs, push ' +
  'tickets to Jira). Use `get_skill` to read the full instructions for one.';

export const getDescription =
  'Fetch a specific skill by name, including its full markdown body. The body ' +
  'is meant to be read as instructions: follow it step by step using the other ' +
  'tools you have available.';

/** Caller identity for the loadInto filter. `mcp` sees every skill. */
export type SkillCaller = SkillLoadTarget | 'mcp';

export interface ListResult {
  name: string;
  description: string | null;
}

export interface GetResult {
  name: string;
  description: string | null;
  body: string;
}

function visibleTo(skill: Skill, caller: SkillCaller): boolean {
  // MCP is intentionally unfiltered — external callers (Claude Desktop,
  // editor integrations) don't carry a `loadInto` identity and should be
  // able to enumerate every skill the user has installed.
  if (caller === 'mcp') return true;
  return skill.loadInto.includes(caller);
}

export function runList(registry: ReadonlyArray<Skill>, caller: SkillCaller): ListResult[] {
  return registry
    .filter(s => visibleTo(s, caller))
    .map(s => ({ name: s.name, description: s.description ?? null }));
}

export interface GetParams { name: string }

export function runGet(
  registry: ReadonlyArray<Skill>,
  caller: SkillCaller,
  p: GetParams,
): GetResult | null {
  const s = registry.find(s => s.name === p.name);
  if (!s) return null;
  if (!visibleTo(s, caller)) return null;
  return { name: s.name, description: s.description ?? null, body: s.body };
}
