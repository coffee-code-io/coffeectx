/**
 * Skill registry.
 *
 * A "skill" is a directory whose `SKILL.md` carries YAML front-matter
 * (agentskills.io convention). The front-matter's optional `coffeecode:`
 * block declares any of three orthogonal capabilities:
 *
 *   - `job` — registers the skill as a scheduler job with the given triggers.
 *     The SKILL.md body becomes the agent's instructions when the job runs.
 *   - `loadInto` — names the agents (`indexerAgent` / `uiAgent`) whose
 *     `list_skills` / `get_skill` tools surface this skill. Omitting hides
 *     the skill from every agent.
 *   - `types` — relative path to a YAML file contributing additional named
 *     types (loaded into the same builtin/user type sync pipeline).
 *   - `requiredEnv` — list of env vars the skill's scripts need at runtime.
 *     Pure declaration; the scheduler warns when configured-env is missing.
 *
 * The dir name is the canonical skill id (= job name, = config key, = the
 * filter key for `loadInto`). The body (everything after the front-matter
 * fence) is plain markdown — the agent reads it as instructions.
 *
 * Skills live in `~/.coffeecode/skills/<name>/` and are re-scanned at each
 * process startup. No DB persistence (mirrors how YAML types are loaded).
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

export type SkillLoadTarget = 'indexerAgent' | 'uiAgent';

export interface SkillJobSpec {
  triggers: SkillTrigger[];
  defaultEnabled?: boolean;
}

export interface Skill {
  /** Directory name; canonical id. */
  name: string;
  description?: string;
  /** Markdown body (everything after the `---\n…\n---` front-matter). */
  body: string;
  /** Resolved absolute path of the skill dir. */
  sourceDir: string;
  job?: SkillJobSpec;
  loadInto: ReadonlyArray<SkillLoadTarget>;
  /** Resolved absolute path of the contributed types YAML, if any. */
  typesPath?: string;
  /** Names of env vars the skill scripts read. Documentation + startup warn. */
  requiredEnv: ReadonlyArray<string>;
}

// ── Filesystem layout ──────────────────────────────────────────────────────

/** Default user skills directory: `~/.coffeecode/skills/`. */
export function defaultUserSkillsDir(): string {
  return join(COFFEECODE_DIR, 'skills');
}

// ── Loading ────────────────────────────────────────────────────────────────

/**
 * Load every skill under `dir`. Each immediate sub-directory containing a
 * `SKILL.md` is treated as one skill. Missing dir → empty list (not an
 * error: most users won't have any skills configured).
 *
 * Parse failures are logged to stderr and the offending skill is skipped;
 * we don't want one malformed skill file to take down the indexer.
 */
export function loadSkillsFromDir(dir: string): Skill[] {
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
      const skill = loadOneSkill(entry, skillDir, skillPath);
      if (skill) skills.push(skill);
    } catch (err) {
      console.warn(`[skills] ${entry}: ${(err as Error).message}`);
    }
  }
  return skills;
}

const FRONT_MATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function loadOneSkill(dirName: string, skillDir: string, skillPath: string): Skill | null {
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
    job: parseJobSpec(cc.job),
    loadInto: parseLoadInto(cc.loadInto),
    typesPath: resolveTypesPath(skillDir, cc.types),
    requiredEnv: parseRequiredEnv(cc.requiredEnv),
  };
}

// ── Front-matter parsing helpers ───────────────────────────────────────────

interface RawFrontMatter {
  name?: string;
  description?: string;
  coffeecode?: RawCoffeecodeBlock;
}

interface RawCoffeecodeBlock {
  job?: RawJobSpec;
  loadInto?: unknown;
  types?: unknown;
  requiredEnv?: unknown;
}

interface RawJobSpec {
  triggers?: unknown;
  defaultEnabled?: unknown;
}

function parseJobSpec(raw: RawJobSpec | undefined): SkillJobSpec | undefined {
  if (!raw) return undefined;
  const triggers = parseTriggers(raw.triggers);
  if (triggers.length === 0) {
    // A job block with no valid triggers is almost certainly a typo; surface
    // it but don't crash — return undefined so the skill is still loadable
    // as a non-job (just won't run on a schedule).
    console.warn(`[skills] job block has no valid triggers; skipping job registration`);
    return undefined;
  }
  return {
    triggers,
    defaultEnabled: typeof raw.defaultEnabled === 'boolean' ? raw.defaultEnabled : undefined,
  };
}

function parseTriggers(raw: unknown): SkillTrigger[] {
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

function parseLoadInto(raw: unknown): SkillLoadTarget[] {
  if (!Array.isArray(raw)) return [];
  const out = new Set<SkillLoadTarget>();
  for (const v of raw) {
    if (v === 'indexerAgent' || v === 'uiAgent') out.add(v);
  }
  return [...out];
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
