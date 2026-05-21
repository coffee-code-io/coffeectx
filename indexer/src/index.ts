#!/usr/bin/env node
/**
 * coffeectx-index CLI
 *
 * Project commands:
 *   init [--name <name>] [--repo <path>]   Create a new project DB
 *   use <name>                              Switch the active project
 *   list-projects                           List all registered projects
 *
 * Type/query commands (active project):
 *   sync-types [--user-dir <path>]          Sync built-in YAML types
 *   load-types <dir>                        Load user-defined YAML types
 *   list-types                              List all named types
 *   types-dot [--out <path>]                Generate Graphviz DOT
 *   query <expression>                      Parse and execute a query expression
 *   search <text>                           Semantic similarity search
 *   exact <value>                           Exact symbol match
 *   regex <pattern>                         Regex symbol match
 *   insert-entries <file.json>              Insert typed entries from a JSON file
 *   load-node <id> [--depth <n>]            Load a node by ID
 *
 * Scheduler:
 *   daemonize                                Start the scheduler (runs jobs by trigger)
 *   job list                                 List all registered jobs
 *   job on <name>                            Enable a job in config + DB
 *   job off <name>                           Disable a job in config + DB
 *   job trigger <name> [--now]               Queue a manual run, or run inline with --now
 *   job status [<name>]                      Show last-run summary and recent runs
 *
 * All commands accept --project <name> to target a non-active project.
 */

import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Db, syncAllTypes, syncFromDir, parseQuery, executeQuery, formatDeepNode, createEmbedFn, loadConfig, resolveProjectEmbed, listEnabledProjects } from '@coffeectx/core';
import type { InsertEntry } from '@coffeectx/core';
import { initProject, promptProjectName } from './init.js';
import {
  loadProjects,
  setActiveProject,
  getActiveProject,
  PROJECTS_PATH,
  DB_DIR,
} from './projects.js';
import { generateTypesDot } from './typesDot.js';
import { Scheduler } from './jobs/scheduler.js';
import { buildJobs } from './jobs/registry.js';
import { jobList, jobOn, jobOff, jobTrigger, jobStatus } from './jobs/cli.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const rawArgs = process.argv.slice(2);

// Strip flags (--name value, --bool) into a separate list so command and
// positional arguments aren't confused by `--project foo job list`.
const flagMap: Record<string, string | true> = {};
const positionals: string[] = [];
for (let i = 0; i < rawArgs.length; i++) {
  const a = rawArgs[i]!;
  if (!a.startsWith('--') && !(a.startsWith('-') && a.length === 2)) {
    positionals.push(a);
    continue;
  }
  const next = rawArgs[i + 1];
  if (next !== undefined && !next.startsWith('-')) {
    flagMap[a] = next;
    i++;
  } else {
    flagMap[a] = true;
  }
}
const args = rawArgs; // kept for callers that still iterate raw args (e.g. query builder)
const command = positionals[0];

function flag(name: string): string | undefined {
  const v = flagMap[name];
  return typeof v === 'string' ? v : undefined;
}

function hasFlag(name: string): boolean {
  return flagMap[name] !== undefined;
}

function positional(index: number): string | undefined {
  return positionals[index];
}

function flagInt(name: string, defaultValue: number): number {
  const raw = flag(name);
  if (raw === undefined) return defaultValue;
  const n = parseInt(raw, 10);
  return isNaN(n) ? defaultValue : n;
}

const globalCfg = loadConfig();

// ── init — does not need an existing DB ───────────────────────────────────────

if (command === 'init') {
  const nameArg = flag('--name') ?? positional(1);
  const repoArg = flag('--repo');
  const logsArg = flag('--logs-path');
  const name = nameArg ?? (await promptProjectName());

  if (!name) {
    console.error('Project name cannot be empty.');
    process.exit(1);
  }

  const repoPath = repoArg ? resolve(repoArg) : undefined;
  const logsPath = logsArg ? resolve(logsArg) : undefined;
  const result = initProject(name, repoPath, logsPath);

  console.log(result.alreadyExisted
    ? `Re-initialized existing project "${result.name}"`
    : `Initialized project "${result.name}"`);
  console.log(`  DB:    ${result.dbPath}`);
  if (result.repoPath) console.log(`  Repo:  ${result.repoPath}`);
  if (result.logsPath) console.log(`  Logs:  ${result.logsPath}`);
  console.log(`  Types: synced ${result.sync.types.synced.length} types, ${result.sync.skills.synced.length} skills`);

  if (result.sync.types.errors.length > 0 || result.sync.skills.errors.length > 0) {
    console.error('  Sync errors:');
    for (const { name: n, error } of [...result.sync.types.errors, ...result.sync.skills.errors]) {
      console.error(`    ${n}: ${error}`);
    }
  }

  console.log(`\nProjects registry: ${PROJECTS_PATH}`);
  process.exit(0);
}

// ── use ───────────────────────────────────────────────────────────────────────

if (command === 'use') {
  const name = positional(1);
  if (!name) {
    console.error('Usage: coffeectx-index use <name>');
    process.exit(1);
  }
  try {
    setActiveProject(name);
    console.log(`Active project: "${name}"`);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
  process.exit(0);
}

// ── list-projects ─────────────────────────────────────────────────────────────

if (command === 'list-projects') {
  const data = loadProjects();
  const names = Object.keys(data.projects);
  if (names.length === 0) {
    console.log('No projects yet. Run: coffeectx-index init');
  } else {
    for (const n of names) {
      const entry = data.projects[n]!;
      const active = n === data.active ? ' ← active' : '';
      console.log(`  ${n}${active}`);
      console.log(`    db:      ${entry.db}`);
      if (entry.repoPath) console.log(`    repo:    ${entry.repoPath}`);
      console.log(`    created: ${entry.created}`);
    }
  }
  console.log(`\nProjects: ${PROJECTS_PATH}`);
  console.log(`DB dir:   ${DB_DIR}`);
  process.exit(0);
}

// ── daemonize supervisor mode (no --project): spawn one child per enabled project
if (command === 'daemonize' && !flag('--project')) {
  const enabled = listEnabledProjects(globalCfg);
  if (enabled.length === 0) {
    console.error('No enabled projects in config. Run `coffeectx-index init` first.');
    process.exit(1);
  }
  await runSupervisor(enabled);
  process.exit(0);
}

// ── All remaining commands require an active project ─────────────────────────

const projects = loadProjects();
let project: ReturnType<typeof getActiveProject>;
try {
  project = getActiveProject(projects, flag('--project'));
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

const embedCfg = resolveProjectEmbed(globalCfg, project.name);
const embedFn = createEmbedFn(embedCfg);
const db = new Db({ path: project.db, embed: embedFn, dimensions: embedCfg.dimensions });

switch (command) {
  case 'sync-types': {
    const userDir = flag('--user-dir') ?? globalCfg.types.userDir;
    console.log(`Syncing types for project "${project.name}"...`);
    const result = syncAllTypes(db, {
      builtinFilter: { include: globalCfg.types.include, exclude: globalCfg.types.exclude },
      userDir,
    });
    console.log(`  Synced ${result.types.synced.length} types, ${result.skills.synced.length} skills`);
    const allErrors = [...result.types.errors, ...result.skills.errors];
    if (allErrors.length > 0) {
      for (const { name, error } of allErrors) console.error(`  ${name}: ${error}`);
      db.close();
      process.exit(1);
    }
    break;
  }

  case 'load-types': {
    const dir = positional(1);
    if (!dir) {
      console.error('Usage: coffeectx-index load-types <dir> [--project <name>]');
      db.close();
      process.exit(1);
    }
    const result = syncFromDir(db, dir, 'user');
    console.log(`Synced ${result.types.synced.length} types, ${result.skills.synced.length} skills from ${dir}`);
    const allErrors = [...result.types.errors, ...result.skills.errors];
    for (const { name, error } of allErrors) console.error(`  ${name}: ${error}`);
    break;
  }

  case 'list-types': {
    const types = db.listNamedTypes();
    if (types.length === 0) {
      console.log(`No named types in "${project.name}". Run: coffeectx-index sync-types`);
    } else {
      console.log(`Types in "${project.name}" (${types.length}):`);
      for (const { name, source } of types) console.log(`  [${source}] ${name}`);
    }
    break;
  }

  case 'types-dot': {
    const dot = generateTypesDot(db, `types_${project.name}`);
    const out = flag('--out');

    if (!out) {
      console.log(dot);
      break;
    }

    const outputPath = resolve(out);
    writeFileSync(outputPath, dot, 'utf-8');
    console.log(`Wrote DOT graph to: ${outputPath}`);
    break;
  }

  case 'insert-entries': {
    const filePath = positional(1);
    if (!filePath) {
      console.error('Usage: coffeectx-index insert-entries <file.json> [--project <name>]');
      console.error('  file.json must be an array of flat entry objects with "$type" required.');
      console.error('  Example: [{ "$type": "Decision", "title": "Use SQLite", "rationale": "..." }]');
      db.close();
      process.exit(1);
    }
    let rawEntries: Array<Record<string, unknown>>;
    try {
      const raw = readFileSync(resolve(filePath), 'utf-8');
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error('Top-level value must be an array');
      rawEntries = parsed as Array<Record<string, unknown>>;
    } catch (err) {
      console.error(`Failed to read entries: ${(err as Error).message}`);
      db.close();
      process.exit(1);
    }
    // Convert flat $type/$id format to InsertEntry
    const entries: InsertEntry[] = [];
    for (let i = 0; i < rawEntries.length; i++) {
      const raw = rawEntries[i]!;
      const $type = raw['$type'];
      if (typeof $type !== 'string' || $type === '') {
        console.error(`Entry[${i}] missing required "$type" field`);
        db.close();
        process.exit(1);
      }
      const $id = raw['$id'];
      const data: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(raw)) {
        if (k === '$type' || k === '$id') continue;
        data[k] = v;
      }
      entries.push({ type: $type, id: typeof $id === 'string' ? $id : undefined, data });
    }
    const result = await db.insertEntries(entries);
    console.log(JSON.stringify(result, null, 2));
    if (result.errors.length > 0) process.exit(1);
    break;
  }

  case 'load-node': {
    const nodeId = positional(1);
    if (!nodeId) {
      console.error('Usage: coffeectx-index load-node <id> [--depth <n>] [--project <name>]');
      db.close();
      process.exit(1);
    }
    const depthArg = flag('--depth');
    const depth = depthArg !== undefined ? parseInt(depthArg, 10) : 10;
    if (isNaN(depth) || depth < 0) {
      console.error('--depth must be a non-negative integer');
      db.close();
      process.exit(1);
    }
    const verbose = args.includes('--verbose') || args.includes('-v');
    let node;
    try {
      node = db.loadNodeDeep(nodeId, depth);
    } catch (err) {
      console.error((err as Error).message);
      db.close();
      process.exit(1);
    }
    const output = verbose ? { id: nodeId, depth, node } : { id: nodeId, node: formatDeepNode(node) };
    console.log(JSON.stringify(output, null, 2));
    break;
  }

  case 'query': {
    const verbose = args.includes('--verbose') || args.includes('-v');
    const includeHidden = args.includes('--include-hidden');
    const depth = flagInt('--depth', 10);
    const limit = flagInt('--limit', 50);
    const offset = flagInt('--offset', 0);

    // Build query text: drop flags and their values from the token list.
    const flagsWithValues = new Set<number>();
    for (const f of ['--depth', '--project', '--limit', '--offset']) {
      const i = args.indexOf(f);
      if (i !== -1) { flagsWithValues.add(i); flagsWithValues.add(i + 1); }
    }
    const queryInput = args
      .slice(1)
      .filter((a, i) => !flagsWithValues.has(i + 1) && a !== '--verbose' && a !== '-v' && a !== '--include-hidden')
      .join(' ')
      .trim();

    if (!queryInput) {
      console.error('Usage: coffeectx-index query <expression> [--limit <n>] [--offset <n>] [--depth <n>] [-v] [--include-hidden] [--project <name>]');
      db.close();
      process.exit(1);
    }

    let parsed;
    try {
      parsed = parseQuery(queryInput);
    } catch (err) {
      console.error(`Query parse error: ${(err as Error).message}`);
      db.close();
      process.exit(1);
    }

    const rawIds = await executeQuery(parsed, db);
    const allIds = includeHidden
      ? rawIds
      : rawIds.filter(id => {
          const selfType = db.getNodeTypeName(id);
          if (selfType) return !db.isHiddenNamedType(selfType);
          const parent = db.findNamedParent(id);
          if (parent && db.isHiddenNamedType(parent.typeName)) return false;
          return true;
        });
    const ids = allIds.slice(offset, offset + limit);
    const results = ids.map(id => {
      try {
        const node = db.loadNodeDeep(id, depth);
        return { id, node: verbose ? node : formatDeepNode(node) };
      } catch {
        return { id, node: null };
      }
    });

    console.log(JSON.stringify({ total: allIds.length, count: results.length, offset, results }, null, 2));
    break;
  }

  case 'search': {
    const verbose = args.includes('--verbose') || args.includes('-v');
    const includeHidden = args.includes('--include-hidden');
    const limit = flagInt('--limit', 10);
    const offset = flagInt('--offset', 0);
    const depth = flagInt('--depth', 3);

    const flagsWithValues = new Set<number>();
    for (const f of ['--limit', '--offset', '--depth', '--project']) {
      const i = args.indexOf(f);
      if (i !== -1) { flagsWithValues.add(i); flagsWithValues.add(i + 1); }
    }
    const text = args
      .slice(1)
      .filter((a, i) => !flagsWithValues.has(i + 1) && a !== '--verbose' && a !== '-v' && a !== '--include-hidden')
      .join(' ')
      .trim();

    if (!text) {
      console.error('Usage: coffeectx-index search <text> [--limit <n>] [--offset <n>] [--depth <n>] [-v] [--include-hidden] [--project <name>]');
      db.close();
      process.exit(1);
    }

    const fetchLimit = includeHidden ? limit : limit * 4;
    const rawResults = await db.searchByText(text, fetchLimit, offset);
    const mapped: unknown[] = [];
    for (const r of rawResults) {
      if (verbose) {
        mapped.push({ id: r.nodeId, distance: r.distance, node: r.node });
        if (mapped.length >= limit) break;
        continue;
      }
      const parent = db.findNamedParent(r.nodeId);
      if (parent) {
        if (!includeHidden && db.isHiddenNamedType(parent.typeName)) continue;
        try {
          const node = formatDeepNode(db.loadNodeDeep(parent.id, depth));
          mapped.push({ id: parent.id, typeName: parent.typeName, distance: r.distance, node, matchedId: r.nodeId });
          if (mapped.length >= limit) break;
          continue;
        } catch { /* fall through */ }
      }
      if (!includeHidden) continue;
      mapped.push({ id: r.nodeId, distance: r.distance, node: r.node });
      if (mapped.length >= limit) break;
    }

    console.log(JSON.stringify({ count: mapped.length, results: mapped }, null, 2));
    break;
  }

  case 'exact': {
    const verbose = args.includes('--verbose') || args.includes('-v');
    const includeHidden = args.includes('--include-hidden');
    const limit = flagInt('--limit', 50);
    const offset = flagInt('--offset', 0);
    const depth = flagInt('--depth', 3);
    const value = positional(1);

    if (!value) {
      console.error('Usage: coffeectx-index exact <value> [--limit <n>] [--offset <n>] [--depth <n>] [-v] [--include-hidden] [--project <name>]');
      db.close();
      process.exit(1);
    }

    const rawIds = db.querySymbolExact(value);
    const allIds = includeHidden
      ? rawIds
      : rawIds.filter(id => {
          const parent = db.findNamedParent(id);
          return !parent || !db.isHiddenNamedType(parent.typeName);
        });
    const ids = allIds.slice(offset, offset + limit);
    const results = ids.map(id => {
      if (verbose) return { id, node: db.loadNode(id) };
      const parent = db.findNamedParent(id);
      if (parent) {
        try {
          const node = formatDeepNode(db.loadNodeDeep(parent.id, depth));
          return { id: parent.id, typeName: parent.typeName, node, matchedId: id };
        } catch { /* fall through */ }
      }
      return { id, node: db.loadNode(id) };
    });

    console.log(JSON.stringify({ total: allIds.length, count: results.length, offset, results }, null, 2));
    break;
  }

  case 'regex': {
    const verbose = args.includes('--verbose') || args.includes('-v');
    const includeHidden = args.includes('--include-hidden');
    const limit = flagInt('--limit', 50);
    const offset = flagInt('--offset', 0);
    const depth = flagInt('--depth', 3);
    const pattern = positional(1);

    if (!pattern) {
      console.error('Usage: coffeectx-index regex <pattern> [--limit <n>] [--offset <n>] [--depth <n>] [-v] [--include-hidden] [--project <name>]');
      db.close();
      process.exit(1);
    }

    try { new RegExp(pattern); } catch {
      console.error(`Invalid regex: ${pattern}`);
      db.close();
      process.exit(1);
    }

    const rawIds = db.querySymbolRegex(pattern);
    const allIds = includeHidden
      ? rawIds
      : rawIds.filter(id => {
          const parent = db.findNamedParent(id);
          return !parent || !db.isHiddenNamedType(parent.typeName);
        });
    const ids = allIds.slice(offset, offset + limit);
    const results = ids.map(id => {
      if (verbose) return { id, node: db.loadNode(id) };
      const parent = db.findNamedParent(id);
      if (parent) {
        try {
          const node = formatDeepNode(db.loadNodeDeep(parent.id, depth));
          return { id: parent.id, typeName: parent.typeName, node, matchedId: id };
        } catch { /* fall through */ }
      }
      return { id, node: db.loadNode(id) };
    });

    console.log(JSON.stringify({ total: allIds.length, count: results.length, offset, results }, null, 2));
    break;
  }

  case 'daemonize': {
    const jobs = buildJobs(db, globalCfg, project.name);
    const scheduler = new Scheduler({ db, dbPath: project.db, project, jobs });
    console.log(`[scheduler] project="${project.name}" jobs=${jobs.length}`);
    await scheduler.start();
    break;
  }

  case 'job': {
    const sub = positional(1);
    const target = positional(2);
    const cliCtx = { db, dbPath: project.db, project, config: globalCfg };

    switch (sub) {
      case 'list':
        jobList(cliCtx);
        break;
      case 'on':
        if (!target) { console.error('Usage: coffeectx-index job on <name>'); db.close(); process.exit(1); }
        jobOn(cliCtx, target);
        break;
      case 'off':
        if (!target) { console.error('Usage: coffeectx-index job off <name>'); db.close(); process.exit(1); }
        jobOff(cliCtx, target);
        break;
      case 'trigger': {
        if (!target) { console.error('Usage: coffeectx-index job trigger <name> [--now]'); db.close(); process.exit(1); }
        const now = args.includes('--now');
        const code = await jobTrigger(cliCtx, target, now);
        if (code !== 0) { db.close(); process.exit(code); }
        break;
      }
      case 'status':
        jobStatus(cliCtx, target);
        break;
      default:
        console.error('Usage: coffeectx-index job {list|on|off|trigger|status} [<name>] [--now]');
        db.close();
        process.exit(1);
    }
    break;
  }

  default: {
    const active = projects.active ? `"${projects.active}"` : 'none';
    const enabledJobs = (() => {
      try {
        return db.listJobs().filter(r => r.enabled).map(r => r.name).join(', ') || 'none';
      } catch { return 'unknown'; }
    })();
    console.log(`coffeectx-index — knowledge graph indexer

Project commands:
  init [--name <name>] [--repo <path>] [--logs-path <path>]  Create a new project DB
  use <name>                                                   Switch the active project
  list-projects                                                List all registered projects

Type / query commands:
  sync-types [--user-dir <path>]         Sync built-in YAML types
  load-types <dir>                       Load user-defined YAML types from a directory
  list-types                             List all named types in active DB
  types-dot [--out <path>]               Generate Graphviz DOT for named type graph
  query <expression>                     Parse and execute a query expression
  search <text>                          Semantic similarity search
  exact <value>                          Exact symbol match
  regex <pattern>                        Regex symbol match (case-insensitive)
  insert-entries <file.json>             Insert typed entries from a JSON file
  load-node <id> [--depth <n>]           Load a node by ID, expanding to depth (default 10)

Scheduler:
  daemonize                              Start the scheduler (runs jobs by trigger)
  job list                               List all registered jobs
  job on <name>                          Enable a job (config + DB)
  job off <name>                         Disable a job (config + DB)
  job trigger <name> [--now]             Queue a manual run, or run inline with --now
  job status [<name>]                    Show last-run summary and recent runs

Options:
  --project <name>       Target a specific project
  --limit <n>            Max results to return (default: 50 for query/exact/regex, 10 for search)
  --offset <n>           Skip this many results (for pagination)
  --depth <n>            Node expansion depth (default: 10 for query/load-node, 3 for search/exact/regex)
  -v / --verbose         Return raw node data instead of formatted output
  --newer-than <ISO>     Only index sessions newer than this date (saved to project config)

Active project:  ${active}
Enabled jobs:    ${enabledJobs}
DB directory:    ${DB_DIR}
Config file:     ${PROJECTS_PATH}
`);
  }
}

db.close();

/**
 * Supervisor mode for `daemonize` with no --project flag.
 *
 * Spawns one child Node process per enabled project, each running
 * `daemonize --project <name>` to host that project's scheduler. Forwards
 * SIGINT/SIGTERM to children and waits for them to exit. Children that die
 * are NOT respawned — this matches the no-KeepAlive policy in setup/daemon.ts.
 */
async function runSupervisor(projectNames: string[]): Promise<void> {
  const entry = fileURLToPath(import.meta.url);
  console.log(`[supervisor] starting ${projectNames.length} child scheduler(s): ${projectNames.join(', ')}`);

  const children: Array<{ name: string; proc: ChildProcess; exited: boolean }> = [];

  for (const name of projectNames) {
    const proc = spawn(process.execPath, [entry, 'daemonize', '--project', name], {
      stdio: ['ignore', 'inherit', 'inherit'],
      env: process.env,
    });
    const child = { name, proc, exited: false };
    children.push(child);
    proc.on('exit', (code, signal) => {
      child.exited = true;
      console.log(`[supervisor] child "${name}" exited code=${code} signal=${signal}`);
      if (children.every(c => c.exited)) {
        console.log('[supervisor] all children exited — shutting down');
        process.exit(0);
      }
    });
    console.log(`[supervisor] spawned "${name}" pid=${proc.pid}`);
  }

  const forward = (sig: NodeJS.Signals) => {
    console.log(`[supervisor] received ${sig}, forwarding to ${children.length} child(ren)`);
    for (const c of children) if (!c.exited) c.proc.kill(sig);
  };
  process.on('SIGINT', () => forward('SIGINT'));
  process.on('SIGTERM', () => forward('SIGTERM'));

  await new Promise<void>(() => { /* never resolves; child exit handler calls process.exit */ });
}
