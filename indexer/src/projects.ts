/**
 * Project registry — backed by ~/.coffeecode/config.yaml (unified config).
 *
 * All project CRUD reads/writes the single config file via @coffeectx/core.
 */

import {
  loadConfig,
  saveConfig,
  dbPathForName,
  COFFEECODE_DIR,
  CONFIG_PATH,
  DB_DIR,
} from '@coffeectx/core';
import type { ProjectEntry } from '@coffeectx/core';

export { COFFEECODE_DIR, CONFIG_PATH as PROJECTS_PATH, DB_DIR };
export type { ProjectEntry };

export interface ProjectsFile {
  active?: string;
  projects: Record<string, ProjectEntry>;
}

export function loadProjects(): ProjectsFile {
  const cfg = loadConfig();
  return { active: cfg.active, projects: cfg.projects };
}

export function registerProject(name: string, dbPath: string, repoPath?: string, logsPath?: string): void {
  const cfg = loadConfig();
  const existing = cfg.projects[name];
  cfg.projects[name] = {
    db: dbPath,
    repoPath: repoPath ?? existing?.repoPath,
    logsPath: logsPath ?? existing?.logsPath,
    created: existing?.created ?? new Date().toISOString(),
  };
  if (!cfg.active) cfg.active = name;
  saveConfig(cfg);
}

export function setProjectLogs(name: string, logsPath: string): void {
  const cfg = loadConfig();
  const entry = cfg.projects[name];
  if (!entry) throw new Error(`Project "${name}" not found`);
  entry.logsPath = logsPath;
  saveConfig(cfg);
}

export function setProjectRepo(name: string, repoPath: string): void {
  const cfg = loadConfig();
  const entry = cfg.projects[name];
  if (!entry) throw new Error(`Project "${name}" not found`);
  entry.repoPath = repoPath;
  saveConfig(cfg);
}

export function setActiveProject(name: string): void {
  const cfg = loadConfig();
  if (!cfg.projects[name]) throw new Error(`Project not found: "${name}"`);
  cfg.active = name;
  saveConfig(cfg);
}

export function getActiveProject(data: ProjectsFile, override?: string): ProjectEntry & { name: string } {
  const name = override ?? data.active;
  if (!name) throw new Error('No active project. Run: coffeectx-index init');
  const entry = data.projects[name];
  if (!entry) throw new Error(`Project "${name}" not found. Run: coffeectx-index init`);
  return { name, ...entry };
}

/** Sanitize a user-supplied name to a safe filename component. */
export function sanitizeName(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_|_$/g, '');
}

export { dbPathForName };
