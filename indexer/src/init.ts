import { mkdirSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { Db, syncAllTypes } from '@retrival-mcp/core';
import type { SyncResult } from '@retrival-mcp/core';
import { DB_DIR, dbPathForName, registerProject, sanitizeName } from './projects.js';

export interface InitResult {
  name: string;
  dbPath: string;
  repoPath?: string;
  logsPath?: string;
  alreadyExisted: boolean;
  sync: SyncResult;
}

/**
 * Initialize a new project database.
 *
 * - Creates ~/.coffeecode/db/<name>.db
 * - Runs schema DDL and syncs all built-in types
 * - Registers the project in ~/.coffeecode/projects.yaml
 * - Sets it as active if no other project is active yet
 */
export function initProject(name: string, repoPath?: string, logsPath?: string): InitResult {
  const safe = sanitizeName(name);
  if (!safe) throw new Error(`"${name}" is not a valid project name`);

  mkdirSync(DB_DIR, { recursive: true });

  const dbPath = dbPathForName(safe);
  const alreadyExisted = existsSync(dbPath);

  // Db constructor creates tables on first open
  const db = new Db({ path: dbPath, embed: async () => new Float32Array(128) });
  const sync = syncAllTypes(db);
  db.close();

  registerProject(safe, dbPath, repoPath, logsPath);

  return { name: safe, dbPath, repoPath, logsPath, alreadyExisted, sync };
}

/** Prompt for a project name interactively (TTY only). */
export async function promptProjectName(): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error('stdin is not a TTY — pass --name <name> explicitly');
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question('Project name: ', answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}
