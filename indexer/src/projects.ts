/**
 * Project registry — ~/.coffeecode/projects.yaml
 *
 * projects:
 *   myproject:
 *     db: /home/user/.coffeecode/db/myproject.db
 *     created: "2026-03-07T00:00:00.000Z"
 * active: myproject
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

export const COFFEECODE_DIR = join(homedir(), '.coffeecode');
export const DB_DIR = join(COFFEECODE_DIR, 'db');
export const PROJECTS_PATH = join(COFFEECODE_DIR, 'projects.yaml');

export interface ProjectEntry {
  db: string;
  repoPath?: string;
  logsPath?: string;   // path to .claude/projects/<id>/ or a specific .jsonl file
  created: string;
}

export interface ProjectsFile {
  active?: string;
  projects: Record<string, ProjectEntry>;
}

export function loadProjects(): ProjectsFile {
  if (!existsSync(PROJECTS_PATH)) return { projects: {} };
  return (parseYaml(readFileSync(PROJECTS_PATH, 'utf-8')) as ProjectsFile | null) ?? { projects: {} };
}

function saveProjects(data: ProjectsFile): void {
  mkdirSync(COFFEECODE_DIR, { recursive: true });
  writeFileSync(PROJECTS_PATH, stringifyYaml(data), 'utf-8');
}

export function registerProject(name: string, dbPath: string, repoPath?: string, logsPath?: string): void {
  const data = loadProjects();
  const existing = data.projects[name];
  data.projects[name] = {
    db: dbPath,
    repoPath: repoPath ?? existing?.repoPath,
    logsPath: logsPath ?? existing?.logsPath,
    created: existing?.created ?? new Date().toISOString(),
  };
  if (!data.active) data.active = name;
  saveProjects(data);
}

export function setProjectLogs(name: string, logsPath: string): void {
  const data = loadProjects();
  const entry = data.projects[name];
  if (!entry) throw new Error(`Project "${name}" not found`);
  entry.logsPath = logsPath;
  saveProjects(data);
}

export function setProjectRepo(name: string, repoPath: string): void {
  const data = loadProjects();
  const entry = data.projects[name];
  if (!entry) throw new Error(`Project "${name}" not found`);
  entry.repoPath = repoPath;
  saveProjects(data);
}

export function setActiveProject(name: string): void {
  const data = loadProjects();
  if (!data.projects[name]) throw new Error(`Project not found: "${name}"`);
  data.active = name;
  saveProjects(data);
}

export function getActiveProject(data: ProjectsFile, override?: string): ProjectEntry & { name: string } {
  const name = override ?? data.active;
  if (!name) throw new Error('No active project. Run: retrival-index init');
  const entry = data.projects[name];
  if (!entry) throw new Error(`Project "${name}" not found. Run: retrival-index init`);
  return { name, ...entry };
}

/** Sanitize a user-supplied name to a safe filename component. */
export function sanitizeName(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_|_$/g, '');
}

export function dbPathForName(name: string): string {
  return join(DB_DIR, `${name}.db`);
}
