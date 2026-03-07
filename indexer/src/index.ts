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
 *   insert-entries <file.json>              Insert typed entries from a JSON file
 *   load-node <id> [--depth <n>]            Load a node by ID with recursive expansion
 *   index [<path>] [--lsp-command <cmd>]   Index repo with LSP (uses stored repoPath if omitted)
 *
 * All DB commands accept --project <name> to target a specific project.
 */

import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { Db, syncAllTypes, syncTypesFromDir, parseQuery, executeQuery, formatDeepNode } from '@retrival-mcp/core';
import type { EmbedFn, InsertEntry } from '@retrival-mcp/core';
import { initProject, promptProjectName } from './init.js';
import {
  loadProjects,
  setActiveProject,
  getActiveProject,
  PROJECTS_PATH,
  DB_DIR,
} from './projects.js';
import { indexWithLsp } from './lsp/indexSymbols.js';
import { resolveLspCommand, LSP_CONFIG_PATH, DEFAULT_LSP_COMMAND } from './lsp/config.js';
import { generateTypesDot } from './typesDot.js';

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

const embedStub: EmbedFn = async () => new Float32Array(128);

// ── init — does not need an existing DB ───────────────────────────────────────

if (command === 'init') {
  const nameArg = flag('--name') ?? positional(1);
  const repoArg = flag('--repo');
  const name = nameArg ?? (await promptProjectName());

  if (!name) {
    console.error('Project name cannot be empty.');
    process.exit(1);
  }

  const repoPath = repoArg ? resolve(repoArg) : undefined;
  const result = initProject(name, repoPath);

  console.log(result.alreadyExisted
    ? `Re-initialized existing project "${result.name}"`
    : `Initialized project "${result.name}"`);
  console.log(`  DB:    ${result.dbPath}`);
  if (result.repoPath) console.log(`  Repo:  ${result.repoPath}`);
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

const db = new Db({ path: project.db, embed: embedStub });

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
      console.error('  file.json must be an array of { type, data } objects.');
      db.close();
      process.exit(1);
    }
    let entries: InsertEntry[];
    try {
      const raw = readFileSync(resolve(filePath), 'utf-8');
      entries = JSON.parse(raw) as InsertEntry[];
      if (!Array.isArray(entries)) throw new Error('Top-level value must be an array');
    } catch (err) {
      console.error(`Failed to read entries: ${(err as Error).message}`);
      db.close();
      process.exit(1);
    }
    const result = await db.insertEntries(entries);
    console.log(JSON.stringify(result, null, 2));
    if (result.errors.length > 0) {
      db.close();
      process.exit(1);
    }
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
    const depthArg = flag('--depth');
    const depth = depthArg !== undefined ? parseInt(depthArg, 10) : 10;

    // Build query text: drop flags and their values from the token list.
    const flagsWithValues = new Set<number>();
    for (const f of ['--depth', '--project']) {
      const i = args.indexOf(f);
      if (i !== -1) { flagsWithValues.add(i); flagsWithValues.add(i + 1); }
    }
    const queryInput = args
      .slice(1)
      .filter((a, i) => !flagsWithValues.has(i + 1) && a !== '--verbose' && a !== '-v')
      .join(' ')
      .trim();

    if (!queryInput) {
      console.error('Usage: retrival-index query <expression> [-v] [--depth <n>] [--project <name>]');
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

    const ids = await executeQuery(parsed, db);
    const results = ids.map(id => {
      try {
        const node = db.loadNodeDeep(id, depth);
        return { id, node: verbose ? node : formatDeepNode(node) };
      } catch {
        return { id, node: null };
      }
    });

    console.log(JSON.stringify({ count: results.length, results }, null, 2));
    break;
  }

  case 'index': {
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

  default: {
    const active = projects.active ? `"${projects.active}"` : 'none';
    console.log(`retrival-index — knowledge graph indexer

Commands:
  init [--name <name>] [--repo <path>]  Create a new project DB
  use <name>                             Switch the active project
  list-projects                          List all registered projects

  sync-types [--user-dir <path>]         Sync built-in YAML types into active DB
  load-types <dir>                       Load user-defined YAML types from a directory
  list-types                             List all named types in active DB
  types-dot [--out <path>]               Generate Graphviz DOT for named type graph
  query <expression>                     Parse and execute a retrival query expression
  insert-entries <file.json>             Insert typed entries from a JSON file
  load-node <id> [--depth <n>]          Load a node by ID, expanding to depth (default 10)
  index [<path>] [--lsp-command <cmd>]  Index repo with LSP (default: typescript-language-server --stdio)

Options:
  --project <name>       Target a specific project
  --repo <path>          Override/set the repo path for the index command
  --lsp-command <cmd>    Override LSP command (otherwise uses ${LSP_CONFIG_PATH} or ${DEFAULT_LSP_COMMAND})

Active project: ${active}
DB directory:   ${DB_DIR}
Projects file:  ${PROJECTS_PATH}
`);
  }
}

db.close();
