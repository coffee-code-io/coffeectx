/**
 * Per-agent pi `ResourceLoader` factory.
 *
 * Wraps `DefaultResourceLoader` with two coffeectx-specific bits:
 *
 *   1. Adds `~/.coffeecode/skills/` and `~/.coffeecode/jobs/` to the pi
 *      skill discovery paths. Skills found in either dir surface to the
 *      agent via pi's native mechanism (system-prompt injection + the
 *      `/skill:<name>` slash command).
 *   2. Filters the loaded skill list against `projects.<p>.skills.<target>`
 *      include/exclude rules — agents only see the skills the user opted
 *      them into. Uses pi's `skillsOverride` hook so the filter applies
 *      everywhere skills surface (prompt + slash commands).
 *
 * Diagnostics from pi (malformed SKILL.md, name collisions, etc.) pass
 * through untouched.
 */

import {
  DefaultResourceLoader,
  getAgentDir,
  type ResourceLoader,
} from '@earendil-works/pi-coding-agent';
import {
  applySkillFilter,
  defaultUserSkillsDir,
  defaultUserJobsDir,
  loadConfig,
  resolveSkillFilter,
  type SkillFilterTarget,
} from '@coffeectx/core';

export interface BuildResourceLoaderOptions {
  /** Project name — drives the per-target filter lookup. */
  projectName: string;
  /** Which filter bucket this agent runs under. */
  target: SkillFilterTarget;
  /**
   * cwd handed to `DefaultResourceLoader`. Pi uses it for project-local
   * SKILL.md discovery (e.g. files inside the repo). Pass the indexer's
   * working directory by default — same as everywhere else we wire pi.
   */
  cwd: string;
  /**
   * `agentDir` — pi's `~/.pi/agent` equivalent. Defaults to whatever pi
   * itself resolves via its `PI_CODING_AGENT_DIR` env var (set inside
   * `@coffeectx/core` to `$COFFEECODE_DIR/.pi/agent`), so coffeectx and
   * pi state stay co-located.
   */
  agentDir?: string;
  /**
   * Role-specific instructions appended to pi's base system prompt. The
   * loader exposes these via `getAppendSystemPrompt()` and pi splices
   * them into the system prompt on every turn — no more prepending the
   * role text to the user's first message.
   */
  appendSystemPrompt?: string[];
}

export async function buildResourceLoader(opts: BuildResourceLoaderOptions): Promise<ResourceLoader> {
  const filter = resolveSkillFilter(loadConfig(), opts.projectName, opts.target);
  const agentDir = opts.agentDir ?? getAgentDir();

  const loader = new DefaultResourceLoader({
    cwd: opts.cwd,
    agentDir,
    additionalSkillPaths: [
      defaultUserSkillsDir(),
      defaultUserJobsDir(),
    ],
    // `skillsOverride` runs every time `getSkills()` is consulted (pi
    // consults it once per session bootstrap + on `reload()`), so changes
    // to the on-disk skills dir AND to the per-project filter take effect
    // on the next session build without bypassing pi's cache.
    skillsOverride: (base) => ({
      skills: applySkillFilter(base.skills, filter),
      diagnostics: base.diagnostics,
    }),
    appendSystemPrompt: opts.appendSystemPrompt,
  });

  // Pi populates the loader lazily; `reload()` forces the first scan so
  // `getSkills()` returns real data before we hand the loader to
  // `createAgentSession`.
  await loader.reload();
  return loader;
}
