/**
 * Process-wide skill registry for the UI server.
 *
 * Skills are loaded once from `~/.coffeecode/skills/` AND
 * `~/.coffeecode/jobs/` on first access and cached for the lifetime of
 * the process — re-scanning isn't useful since skills don't change at
 * runtime (same policy as builtin types). Each entry is tagged with its
 * `category` so the UI knows whether to render it under skills or jobs.
 *
 * The cached list is consumed by:
 *   - the Skills / Scheduler UI routes (`/api/p/:p/skills`)
 *   - the per-target ResourceLoader (`skillResourceLoader.ts` reads the
 *     dirs itself; this registry exists for the UI's catalog view)
 */

import { loadAllSkills, type Skill } from '@coffeectx/core';

let CACHED: ReadonlyArray<Skill> | null = null;

export function getSkillRegistry(): ReadonlyArray<Skill> {
  if (CACHED === null) {
    CACHED = loadAllSkills();
  }
  return CACHED;
}

/**
 * Force a re-scan from disk. Currently only useful for tests; the UI never
 * mutates the on-disk skills dirs so callers shouldn't need this. Exposed
 * so the option is there if we ever wire a "reload skills" admin button.
 */
export function reloadSkillRegistry(): ReadonlyArray<Skill> {
  CACHED = loadAllSkills();
  return CACHED;
}
