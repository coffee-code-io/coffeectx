#!/usr/bin/env node
/**
 * Bump every workspace's version + every `@coffeectx/*` dep range + refresh
 * the lockfile + sanity-build + commit + tag.
 *
 * Usage:
 *   node scripts/bump-version.mjs              # patch bump
 *   node scripts/bump-version.mjs minor
 *   node scripts/bump-version.mjs major
 *   node scripts/bump-version.mjs 1.2.3        # explicit version
 *
 * Conventions:
 *   - All workspaces are kept in lockstep (one version for the whole monorepo).
 *   - `@coffeectx/*` dep ranges are rewritten to `^<new>` so consumers see
 *     a coherent version graph and `npm install` resolves to the new locals.
 *   - Root package.json's `version` is left alone (it's private + version-less)
 *     but its `dependencies` map is rewritten.
 *   - Single commit + annotated tag `v<new>`; no auto-push (review locally
 *     before `git push --follow-tags`).
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ── 1. Parse arg + compute the new version ────────────────────────────────

const arg = process.argv[2] ?? 'patch';
const canonical = readJson(join(REPO_ROOT, 'packages/core/package.json'));
const current = canonical.version;
const next = incVersion(current, arg);
console.log(`Current: ${current}`);
console.log(`Next:    ${next}\n`);

// ── 2. Enumerate every package.json in the monorepo ───────────────────────

const root = readJson(join(REPO_ROOT, 'package.json'));
const workspacePatterns = Array.isArray(root.workspaces) ? root.workspaces : [];
const files = resolveWorkspacePackageJsons(REPO_ROOT, workspacePatterns);
files.unshift(join(REPO_ROOT, 'package.json'));   // root first so its log line reads naturally

let touched = 0;
for (const file of files) {
  const pkg = readJson(file);
  let changed = false;

  // Skip root's own `version` field — it has none on purpose.
  if (file !== join(REPO_ROOT, 'package.json') && pkg.version && pkg.version !== next) {
    pkg.version = next;
    changed = true;
  }

  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const deps = pkg[field];
    if (!deps) continue;
    for (const [name, range] of Object.entries(deps)) {
      if (!name.startsWith('@coffeectx/')) continue;
      // Preserve the caret prefix style (`^`) regardless of what was there.
      // Pinned (`0.1.0`), tilde (`~0.1.0`), star, file:, etc. all collapse to
      // `^<new>` — anything else is incidental and not worth preserving.
      const nextRange = `^${next}`;
      if (range !== nextRange) {
        deps[name] = nextRange;
        changed = true;
      }
    }
  }

  if (changed) {
    writeJson(file, pkg);
    console.log(`  bumped: ${relativeFrom(REPO_ROOT, file)}`);
    touched++;
  }
}

if (touched === 0) {
  console.log('\nNothing to bump — every workspace + dep range already at the target.');
  process.exit(0);
}
console.log(`\nUpdated ${touched} package.json file(s).`);

// ── 3. Refresh the lockfile so node_modules link to the new versions ──────

console.log('\nRunning `npm install` to refresh package-lock.json...');
run('npm install', REPO_ROOT);

// ── 4. Sanity-build everything before we commit ───────────────────────────

console.log('\nBuilding all workspaces...');
run('npm run build --workspaces --if-present', REPO_ROOT);

// ── 5. Commit + tag ───────────────────────────────────────────────────────

console.log('\nCommitting + tagging...');
run('git add -A', REPO_ROOT);
const message = `Release v${next}`;
run(`git commit -m ${shellQuote(message)}`, REPO_ROOT);
run(`git tag -a v${next} -m ${shellQuote(message)}`, REPO_ROOT);

console.log(`\nReleased v${next}. To push:\n  git push --follow-tags`);
console.log('To publish:\n  npm run publish-all');

// ── Helpers ───────────────────────────────────────────────────────────────

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function writeJson(path, value) {
  // Preserve npm's two-space indent + trailing newline.
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf-8');
}

function incVersion(current, level) {
  if (/^\d+\.\d+\.\d+$/.test(level)) return level;
  const m = current.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) throw new Error(`Cannot parse current version "${current}".`);
  const [, maj, min, pat] = m.map(s => Number(s));
  if (level === 'patch') return `${maj}.${min}.${pat + 1}`;
  if (level === 'minor') return `${maj}.${min + 1}.0`;
  if (level === 'major') return `${maj + 1}.0.0`;
  throw new Error(`Unknown bump level "${level}" — expected patch | minor | major | <x.y.z>.`);
}

function resolveWorkspacePackageJsons(repoRoot, patterns) {
  // npm workspaces accept globs; we only need the immediate-child variant
  // (`packages/*`, `secrets/packages/*`) plus bare paths. Anything fancier
  // doesn't exist in this monorepo today.
  const out = [];
  for (const pat of patterns) {
    if (pat.endsWith('/*')) {
      const parent = join(repoRoot, pat.slice(0, -2));
      for (const entry of safeReaddir(parent)) {
        const candidate = join(parent, entry, 'package.json');
        if (existsFile(candidate)) out.push(candidate);
      }
    } else {
      const candidate = join(repoRoot, pat, 'package.json');
      if (existsFile(candidate)) out.push(candidate);
    }
  }
  return out;
}

function safeReaddir(path) {
  try { return readdirSync(path); } catch { return []; }
}

function existsFile(path) {
  try { return statSync(path).isFile(); } catch { return false; }
}

function relativeFrom(repoRoot, path) {
  return path.startsWith(repoRoot + '/') ? path.slice(repoRoot.length + 1) : path;
}

function run(command, cwd) {
  execSync(command, { cwd, stdio: 'inherit' });
}

function shellQuote(s) {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
