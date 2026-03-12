#!/usr/bin/env node
/**
 * retrival-index CLI
 *
 * Commands:
 *   init [--name <name>] [--repo <path>]   Create a new project DB
 *   use <name>                              Switch the active project
 *   list-projects                           List all registered projects
 *   sync-types [--user-dir <path>]          Sync built-in YAML types into active DB
 *   load-types <dir>                        Load user-defined YAML types from a directory
 *   list-types                              List all named types in active DB
 *   types-dot [--out <path>]                Generate Graphviz DOT for named type graph
 *   query <expression>                      Parse and execute a retrival query expression
 *   search <text>                           Semantic similarity search
 *   exact <value>                           Exact symbol match
 *   regex <pattern>                         Regex symbol match (case-insensitive)
 *   insert-entries <file.json>              Insert typed entries from a JSON file
 *   load-node <id> [--depth <n>]            Load a node by ID with recursive expansion
 *   index-lsp [<path>] [--lsp-command <cmd>]  Index repo with LSP (uses stored repoPath if omitted)
 *   index-logs [<path>...]                    Index Claude Code JSONL logs (uses stored logsPath if omitted)
 *
 * All DB commands accept --project <name> to target a specific project.
 */

import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { Db, syncAllTypes, syncTypesFromDir, parseQuery, executeQuery, formatDeepNode, createEmbedFn, loadEmbedConfig } from '@coffeectx/core';
import type { InsertEntry } from '@coffeectx/core';
import { initProject, promptProjectName } from './init.js';
import {
  loadProjects,
  setActiveProject,
  setProjectLogs,
  getActiveProject,
  PROJECTS_PATH,
  DB_DIR,
} from './projects.js';
import { indexWithLsp } from './lsp/indexSymbols.js';
import { resolveLspCommand, LSP_CONFIG_PATH, DEFAULT_LSP_COMMAND } from './lsp/config.js';
import { generateTypesDot } from './typesDot.js';
import { indexLogs } from './agentLog/indexLogs.js';
import { indexAgent } from './agentRun/indexAgent.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0];

function flag(name: string): string | undefined {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
}

function positional(index: number): string | undefined {
  // Return args[index] if it doesn't look like a flag
  return args[index]?.startsWith('--') ? undefined : args[index];
}

function flagInt(name: string, defaultValue: number): number {
  const raw = flag(name);
  if (raw === undefined) return defaultValue;
  const n = parseInt(raw, 10);
  return isNaN(n) ? defaultValue : n;
}

const embedCfg = loadEmbedConfig();
const embedFn = createEmbedFn(embedCfg);

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
  const name = args[1];
  if (!name) {
    console.error('Usage: retrival-index use <name>');
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
    console.log('No projects yet. Run: retrival-index init');
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

// ── All remaining commands require an active project ─────────────────────────

const projects = loadProjects();
let project: ReturnType<typeof getActiveProject>;
try {
  project = getActiveProject(projects, flag('--project'));
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

const db = new Db({ path: project.db, embed: embedFn, dimensions: embedCfg.dimensions });

switch (command) {
  case 'sync-types': {
    const userDir = flag('--user-dir');
    console.log(`Syncing types for project "${project.name}"...`);
    const result = userDir ? syncAllTypes(db, userDir) : syncAllTypes(db);
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
    const dir = args[1];
    if (!dir) {
      console.error('Usage: retrival-index load-types <dir> [--project <name>]');
      db.close();
      process.exit(1);
    }
    const result = syncTypesFromDir(db, dir, 'user');
    console.log(`Synced ${result.types.synced.length} types, ${result.skills.synced.length} skills from ${dir}`);
    const allErrors = [...result.types.errors, ...result.skills.errors];
    for (const { name, error } of allErrors) console.error(`  ${name}: ${error}`);
    break;
  }

  case 'list-types': {
    const types = db.listNamedTypes();
    if (types.length === 0) {
      console.log(`No named types in "${project.name}". Run: retrival-index sync-types`);
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
      console.error('Usage: retrival-index insert-entries <file.json> [--project <name>]');
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
      console.error('Usage: retrival-index load-node <id> [--depth <n>] [--project <name>]');
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
      console.error('Usage: retrival-index query <expression> [--limit <n>] [--offset <n>] [--depth <n>] [-v] [--include-hidden] [--project <name>]');
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
      console.error('Usage: retrival-index search <text> [--limit <n>] [--offset <n>] [--depth <n>] [-v] [--include-hidden] [--project <name>]');
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
      console.error('Usage: retrival-index exact <value> [--limit <n>] [--offset <n>] [--depth <n>] [-v] [--include-hidden] [--project <name>]');
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
      console.error('Usage: retrival-index regex <pattern> [--limit <n>] [--offset <n>] [--depth <n>] [-v] [--include-hidden] [--project <name>]');
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

  case 'index-lsp': {
    // Resolve repo path: explicit arg > --repo flag > stored project repoPath
    const pathArg = positional(1);
    const repoFlag = flag('--repo');
    const rawRepo = pathArg ?? repoFlag ?? project.repoPath;

    if (!rawRepo) {
      console.error(
        'No repo path specified. Pass a path, use --repo <path>, or set one during init.',
      );
      db.close();
      process.exit(1);
    }

    const repoPath = resolve(rawRepo);

    // LSP command resolution order:
    // 1) --lsp-command
    // 2) ~/.coffeecode/lsp.yaml (servers.typescript, then default)
    // 3) built-in default
    const lspCommandFlag = resolveLspCommand(flag('--lsp-command'), 'typescript');
    const [lspBin, ...lspArgs] = lspCommandFlag.trim().split(/\s+/).filter(Boolean);

    if (!lspBin) {
      console.error(`Invalid LSP command resolved from --lsp-command or ${LSP_CONFIG_PATH}`);
      db.close();
      process.exit(1);
    }

    console.log(`Indexing "${repoPath}" → project "${project.name}"`);
    console.log(`LSP: ${lspCommandFlag}`);

    const lspBinPath = lspBin.startsWith('~/') ? `${homedir()}/${lspBin.slice(2)}` : lspBin;

    // Re-open db with a real embed stub for now (embed provider wired separately)
    const result = await indexWithLsp(db, repoPath, lspBinPath, lspArgs);

    console.log(`\nDone.`);
    console.log(`  Files:  ${result.files}`);
    console.log(`  Nodes:  ${result.nodes}`);
    if (result.errors.length > 0) {
      console.error(`  Errors: ${result.errors.length}`);
      for (const { file, error } of result.errors) console.error(`    ${file}: ${error}`);
    }
    break;
  }

  case 'index-agent': {
    const batchStepArg = flag('--batch-step');
    const qwenPathArg = flag('--qwen-path');

    const batchStep = batchStepArg !== undefined ? parseInt(batchStepArg, 10) : undefined;

    if (batchStep !== undefined && isNaN(batchStep)) {
      console.error('--batch-step must be an integer');
      db.close();
      process.exit(1);
    }

    console.log(`Running agent indexer for project "${project.name}"...`);

    const result = await indexAgent({
      db,
      dbPath: project.db,
      batchStep,
      pathToQwenExecutable: qwenPathArg ? resolve(qwenPathArg) : undefined,
    });

    console.log(`  Batches: ${result.batches}`);
    if (result.errors.length > 0) {
      console.error(`  Errors: ${result.errors.length}`);
      for (const { error } of result.errors) {
        console.error(`    ${error}`);
      }
      db.close();
      process.exit(1);
    }
    break;
  }

  case 'index-logs': {
    // --logs-path <path> saves the path and uses it; otherwise fall back to stored value
    const logsPathFlag = flag('--logs-path');
    if (logsPathFlag) {
      const resolved = resolve(logsPathFlag);
      setProjectLogs(project.name, resolved);
      project.logsPath = resolved;
    }
    // Resolve log paths: explicit positional args > stored project logsPath
    const explicitPaths = args.slice(1).filter(a => !a.startsWith('--')).map(p => resolve(p));
    const logPaths = explicitPaths.length > 0 ? explicitPaths
      : project.logsPath ? [project.logsPath]
      : [];
    if (logPaths.length === 0) {
      console.error('Usage: retrival-index index-logs [<path>...] [--logs-path <path>] [--project <name>]');
      console.error('  Paths may be .jsonl files or directories. --logs-path saves the path for future runs.');
      db.close();
      process.exit(1);
    }
    console.log(`Indexing agent logs for project "${project.name}"...`);
    const result = await indexLogs(db, logPaths);
    console.log(`  Files:    ${result.files}`);
    console.log(`  Sessions: ${result.sessions}`);
    console.log(`  Events:   ${result.events}`);
    console.log(`  Inserted: ${result.inserted} nodes`);
    if (result.errors.length > 0) {
      console.error(`  Errors: ${result.errors.length}`);
      for (const { file, error, stack } of result.errors) {
        console.error(`    ${file}: ${error}`);
        if (stack) console.error(stack.split('\n').slice(1).map(l => `      ${l}`).join('\n'));
      }
      db.close();
      process.exit(1);
    }
    break;
  }

  default: {
    const active = projects.active ? `"${projects.active}"` : 'none';
    console.log(`retrival-index — knowledge graph indexer

Commands:
  init [--name <name>] [--repo <path>] [--logs-path <path>]  Create a new project DB
  use <name>                                                   Switch the active project
  list-projects                                                List all registered projects

  sync-types [--user-dir <path>]         Sync built-in YAML types into active DB
  load-types <dir>                       Load user-defined YAML types from a directory
  list-types                             List all named types in active DB
  types-dot [--out <path>]               Generate Graphviz DOT for named type graph
  query <expression>                     Parse and execute a retrival query expression
  search <text>                          Semantic similarity search
  exact <value>                          Exact symbol match
  regex <pattern>                        Regex symbol match (case-insensitive)
  insert-entries <file.json>             Insert typed entries from a JSON file
  load-node <id> [--depth <n>]           Load a node by ID, expanding to depth (default 10)
  index-lsp [<path>] [--lsp-command <cmd>]                        Index repo with LSP (default: typescript-language-server --stdio)
  index-logs [<path>...]                                           Index Claude Code JSONL logs (uses stored logsPath if none given)
  index-agent [--skill <name>] [--batch-step <n>] [--suffix-len <n>] [--qwen-path <path>]  Run agent to extract entities from indexed log events

Options:
  --project <name>       Target a specific project
  --limit <n>            Max results to return (default: 50 for query/exact/regex, 10 for search)
  --offset <n>           Skip this many results (for pagination)
  --depth <n>            Node expansion depth (default: 10 for query/load-node, 3 for search/exact/regex)
  -v / --verbose         Return raw node data instead of formatted output
  --repo <path>          Override/set the repo path for index-lsp
  --logs-path <path>     Set default logs path for index-logs (stored in projects.yaml)
  --lsp-command <cmd>    Override LSP command (otherwise uses ${LSP_CONFIG_PATH} or ${DEFAULT_LSP_COMMAND})

Active project: ${active}
DB directory:   ${DB_DIR}
Projects file:  ${PROJECTS_PATH}
`);
  }
}

db.close();
