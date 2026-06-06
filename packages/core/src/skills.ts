/**
 * Skill registry.
 *
 * A "skill" is a directory whose `SKILL.md` follows the Anthropic Agent
 * Skills convention (`<dir>/SKILL.md`, YAML front-matter + markdown body).
 * Two directories are scanned at startup, each tagged with a different
 * `category`:
 *
 *   ~/.coffeecode/skills/<name>/   → category 'skill'  — agent-callable; pi's
 *                                     ResourceLoader injects these into every
 *                                     project agent's system prompt and as
 *                                     `/skill:<name>` slash commands.
 *   ~/.coffeecode/jobs/<name>/     → category 'job'    — scheduler picks
 *                                     these up. Job-shaped skills can also
 *                                     be invoked by agents (same loader).
 *
 * Front-matter that pi already understands: `name`, `description`,
 * `disable-model-invocation`. Anything under the optional `coffeecode:`
 * block is coffeectx-specific extension data:
 *
 *   - `job.triggers` / `job.defaultEnabled` — scheduler defaults (only
 *     meaningful for `category: 'job'`; overridable in config.yaml).
 *   - `types` — relative path to a YAML contributing named types.
 *   - `requiredEnv` — env vars the skill scripts read at runtime (doc +
 *     startup warn; populated at run time from
 *     `projects.<p>.jobs[<name>].env`).
 *
 * Per-agent visibility (`loadInto`) moved out of front-matter and into the
 * per-project `projects.<p>.skills` config, so users decide which skills
 * each agent sees without touching the skill files themselves.
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { COFFEECODE_DIR } from './config.js';

// ── Trigger shapes (mirrors indexer JobTrigger; core-resident so the
//    registry is independent of the indexer workspace) ───────────────────────

export type SkillTrigger =
  | { kind: 'timer'; intervalMs: number }
  | { kind: 'onTypeInsert'; typeNames: string[] }
  | { kind: 'onNodeState'; typeNames: string[]; state: string }
  | { kind: 'cron'; expression: string };

export interface SkillJobSpec {
  triggers: SkillTrigger[];
  defaultEnabled?: boolean;
}

/** Which on-disk dir the skill came from. Drives whether the scheduler
 *  registers a job for it and (eventually) where the UI groups it. */
export type SkillCategory = 'skill' | 'job';

export interface Skill {
  /** Directory name; canonical id. */
  name: string;
  description?: string;
  /** Markdown body (everything after the `---\n…\n---` front-matter). */
  body: string;
  /** Resolved absolute path of the skill dir. */
  sourceDir: string;
  /** Which top-level dir this skill was found in. */
  category: SkillCategory;
  /** Parsed `coffeecode.job` defaults; only honoured for `category: 'job'`. */
  job?: SkillJobSpec;
  /** Resolved absolute path of the contributed types YAML, if any. */
  typesPath?: string;
  /** Names of env vars the skill scripts read. Documentation + startup warn. */
  requiredEnv: ReadonlyArray<string>;
  /**
   * Anthropic Agent Skills `allowed-tools` field. Optional. When set, this
   * is the only tool allowlist the skill's job (or skill-invocation) sees;
   * the default is "read-only graph queries only" for user jobs and
   * "DB-writes + graph queries, no FS" for hardcoded indexing skills.
   *
   * Names may include shell-style globs (`mcp__*`, `read*`). The indexer
   * expands them against the live tool registry at session-build time —
   * pi itself only accepts exact names in `tools: string[]`.
   */
  allowedTools?: ReadonlyArray<string>;
  /**
   * True iff the skill's front-matter sets `coffeecode.indexer: true`. The
   * unified per-Span indexer runner enumerates these and injects each one's
   * `name` + `description` into the base prompt as a routing catalog —
   * the agent then invokes `/skill:<name>` when a span matches.
   *
   * Decoupled from `typesPath` so a skill can contribute *only* a prompt
   * (operating on built-in types) without forcing a synthetic YAML.
   */
  isIndexer: boolean;
}

// ── Filesystem layout ──────────────────────────────────────────────────────

/** Default user skills directory: `~/.coffeecode/skills/`. */
export function defaultUserSkillsDir(): string {
  return join(COFFEECODE_DIR, 'skills');
}

/** Default user jobs directory: `~/.coffeecode/jobs/`. */
export function defaultUserJobsDir(): string {
  return join(COFFEECODE_DIR, 'jobs');
}

// ── Loading ────────────────────────────────────────────────────────────────

export interface LoadAllSkillsOptions {
  /** Path to the skills dir. Defaults to `defaultUserSkillsDir()`. */
  skillsDir?: string;
  /** Path to the jobs dir. Defaults to `defaultUserJobsDir()`. */
  jobsDir?: string;
}

/**
 * Walk both `skills/` and `jobs/` dirs, returning every loadable skill
 * tagged with its source category. Each entry's `sourceDir` resolves to
 * the leaf skill directory (e.g. `~/.coffeecode/jobs/foo`).
 *
 * Name collisions across the two dirs are warned about; the first-seen
 * entry wins (skills/ scanned first). Users hitting this should rename
 * one of the duplicates.
 */
export function loadAllSkills(opts: LoadAllSkillsOptions = {}): Skill[] {
  const skillsDir = opts.skillsDir ?? defaultUserSkillsDir();
  const jobsDir = opts.jobsDir ?? defaultUserJobsDir();

  const out: Skill[] = [];
  const seen = new Set<string>();
  for (const skill of loadSkillsFromDir(skillsDir, 'skill')) {
    seen.add(skill.name);
    out.push(skill);
  }
  for (const skill of loadSkillsFromDir(jobsDir, 'job')) {
    if (seen.has(skill.name)) {
      console.warn(
        `[skills] name collision: "${skill.name}" exists in both skills/ and jobs/ — keeping the skills/ entry, ignoring jobs/`,
      );
      continue;
    }
    out.push(skill);
  }
  return out;
}

/**
 * Load every skill under `dir` and tag it with `category`. Each immediate
 * sub-directory containing a `SKILL.md` is treated as one skill. Missing
 * dir → empty list (not an error: most users won't have either dir set up
 * on day one).
 *
 * Parse failures are logged to stderr and the offending skill is skipped;
 * we don't want one malformed skill file to take down the indexer.
 */
export function loadSkillsFromDir(dir: string, category: SkillCategory = 'skill'): Skill[] {
  if (!existsSync(dir)) return [];
  let entries: string[];
  try { entries = readdirSync(dir); }
  catch (err) {
    console.warn(`[skills] cannot read ${dir}: ${(err as Error).message}`);
    return [];
  }

  const skills: Skill[] = [];
  for (const entry of entries) {
    const skillDir = join(dir, entry);
    let stat;
    try { stat = statSync(skillDir); } catch { continue; }
    if (!stat.isDirectory()) continue;

    const skillPath = join(skillDir, 'SKILL.md');
    if (!existsSync(skillPath)) continue;

    try {
      const skill = loadOneSkill(entry, skillDir, skillPath, category);
      if (skill) skills.push(skill);
    } catch (err) {
      console.warn(`[skills] ${entry}: ${(err as Error).message}`);
    }
  }
  return skills;
}

const FRONT_MATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function loadOneSkill(dirName: string, skillDir: string, skillPath: string, category: SkillCategory): Skill | null {
  const raw = readFileSync(skillPath, 'utf-8');
  const m = raw.match(FRONT_MATTER_RE);
  if (!m) throw new Error(`SKILL.md missing front-matter (expected \`---\` fenced block)`);

  const front = parseYaml(m[1]!) as RawFrontMatter | null;
  const body = raw.slice(m[0].length).trimStart();

  // `name` in front-matter is informational; the dir name is authoritative
  // so that move-/rename-on-disk is the obvious way to rename a skill.
  if (front?.name && front.name !== dirName) {
    console.warn(
      `[skills] ${dirName}: front-matter name "${front.name}" does not match directory; using directory name.`,
    );
  }

  const cc = (front?.coffeecode ?? {}) as RawCoffeecodeBlock;

  return {
    name: dirName,
    description: typeof front?.description === 'string' ? front.description : undefined,
    body,
    sourceDir: skillDir,
    category,
    job: parseJobSpec(cc.job),
    typesPath: resolveTypesPath(skillDir, cc.types),
    requiredEnv: parseRequiredEnv(cc.requiredEnv),
    allowedTools: parseAllowedTools(front),
    isIndexer: cc.indexer === true,
  };
}

// ── Front-matter parsing helpers ───────────────────────────────────────────

interface RawFrontMatter {
  name?: string;
  description?: string;
  coffeecode?: RawCoffeecodeBlock;
  // Anthropic Agent Skills convention — kebab-case in YAML, parsed below.
  'allowed-tools'?: unknown;
  allowedTools?: unknown;
}

/**
 * Parse the Anthropic Agent Skills `allowed-tools` field. Accepts either a
 * YAML array (`["search", "raw_query"]`) or a comma-separated string
 * (`"search, raw_query, mcp__*"`). Empty / missing → undefined (skill
 * inherits the runner's default allowlist).
 */
function parseAllowedTools(front: RawFrontMatter | null | undefined): ReadonlyArray<string> | undefined {
  if (!front) return undefined;
  const raw = front['allowed-tools'] ?? front.allowedTools;
  if (raw === undefined || raw === null) return undefined;
  if (Array.isArray(raw)) {
    const out = raw.filter((v): v is string => typeof v === 'string' && v.length > 0).map(s => s.trim());
    return out.length > 0 ? out : undefined;
  }
  if (typeof raw === 'string') {
    const out = raw.split(',').map(s => s.trim()).filter(s => s.length > 0);
    return out.length > 0 ? out : undefined;
  }
  console.warn(`[skills] allowed-tools must be an array or comma-separated string; got ${typeof raw}`);
  return undefined;
}

interface RawCoffeecodeBlock {
  job?: RawJobSpec;
  types?: unknown;
  requiredEnv?: unknown;
  /** Marker flag — opts the skill into the per-Span indexer's routing catalog. */
  indexer?: boolean;
  // Legacy `loadInto` is silently ignored; per-agent visibility moved to
  // `projects.<p>.skills` config in the v2 refactor.
}

interface RawJobSpec {
  triggers?: unknown;
  defaultEnabled?: unknown;
}

function parseJobSpec(raw: RawJobSpec | undefined): SkillJobSpec | undefined {
  if (!raw) return undefined;
  const triggers = parseTriggers(raw.triggers);
  // Empty triggers is fine here — the scheduler treats a job with no
  // triggers as manual-only (visible in the Jobs UI; the trigger button
  // fires it). The user can also override / add triggers in config.yaml.
  return {
    triggers,
    defaultEnabled: typeof raw.defaultEnabled === 'boolean' ? raw.defaultEnabled : undefined,
  };
}

/** Exported so the indexer/config can reuse the same trigger validation. */
export function parseTriggers(raw: unknown): SkillTrigger[] {
  if (!Array.isArray(raw)) return [];
  const out: SkillTrigger[] = [];
  for (const t of raw) {
    if (!t || typeof t !== 'object') continue;
    const obj = t as Record<string, unknown>;
    const kind = obj['kind'];
    if (kind === 'timer' && typeof obj['intervalMs'] === 'number' && obj['intervalMs'] > 0) {
      out.push({ kind: 'timer', intervalMs: obj['intervalMs'] });
    } else if (kind === 'onTypeInsert' && Array.isArray(obj['typeNames'])) {
      const typeNames = (obj['typeNames'] as unknown[]).filter((n): n is string => typeof n === 'string');
      if (typeNames.length > 0) out.push({ kind: 'onTypeInsert', typeNames });
    } else if (kind === 'onNodeState' && Array.isArray(obj['typeNames']) && typeof obj['state'] === 'string') {
      const typeNames = (obj['typeNames'] as unknown[]).filter((n): n is string => typeof n === 'string');
      if (typeNames.length > 0) out.push({ kind: 'onNodeState', typeNames, state: obj['state'] });
    } else if (kind === 'cron' && typeof obj['expression'] === 'string' && obj['expression'].trim().length > 0) {
      out.push({ kind: 'cron', expression: obj['expression'].trim() });
    } else {
      console.warn(`[skills] ignored unknown/invalid trigger: ${JSON.stringify(t)}`);
    }
  }
  return out;
}

function resolveTypesPath(skillDir: string, raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  // Absolute paths are honoured as-is; relative paths resolve against the
  // skill's own directory so users can write `./types.yaml`.
  const p = isAbsolute(raw) ? raw : resolve(skillDir, raw);
  if (!existsSync(p)) {
    console.warn(`[skills] types: "${raw}" → ${p} does not exist; skipping types contribution`);
    return undefined;
  }
  return p;
}

function parseRequiredEnv(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === 'string' && v.length > 0);
}
