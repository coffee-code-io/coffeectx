/**
 * /api/p/:p/secrets — read and edit the resolved secrets project in
 * `~/.coffeecode/secrets.yaml` for a coffeectx project. Plus an indexer-side
 * setter for `ProjectEntry.secretsProject` (which controls which secrets
 * project this coffeectx project maps to).
 *
 *   GET    /api/p/:p/secrets                     — full view (project,
 *                                                  whitelist with computed
 *                                                  file hashes, secret names)
 *   PUT    /api/p/:p/secrets/secretsProject      — { secretsProject: string|null }
 *   POST   /api/p/:p/secrets/whitelist           — append rule
 *   PUT    /api/p/:p/secrets/whitelist/:index    — replace rule at index
 *   DELETE /api/p/:p/secrets/whitelist/:index    — remove rule
 *   POST   /api/p/:p/secrets/hash                — { path } -> { exists, hash? }
 *
 * Whitelist hashes are always computed server-side from the supplied paths
 * (clients submit `{ path }[]`, not pre-computed hashes). Missing files
 * cause a 400; the same view shape is returned on success so the client
 * doesn't have to re-fetch.
 */

import { existsSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import {
  loadConfig,
  updateConfig,
  resolveSecretsProjectName,
} from '@coffeectx/core';
import {
  loadSecretsConfig,
  saveSecretsConfig,
  sha256File,
  DEFAULT_CONFIG_PATH,
  expandHome,
  resolvePath,
  type SecretsConfig,
  type WhitelistRule,
} from '@coffeectx/secrets-core';

interface FileEntryView {
  path: string;
  hash: string;
  exists: boolean;
  currentHash?: string;
  matches?: boolean;
}

interface WhitelistRuleView {
  command: string;
  files: FileEntryView[];
  allowed_env: string[];
  secrets: string[];
}

interface SecretsResponse {
  secretsProject: string;
  exists: boolean;
  directory?: string;
  secretNames: string[];
  whitelist: WhitelistRuleView[];
  configPath: string;
}

interface WhitelistRuleInput {
  command: string;
  files: { path: string }[];
  allowed_env?: string[];
  secrets?: string[];
}

const SECRETS_CONFIG_PATH = expandHome(DEFAULT_CONFIG_PATH);

function loadSecretsOrEmpty(): SecretsConfig {
  if (!existsSync(SECRETS_CONFIG_PATH)) return { projects: {} };
  return loadSecretsConfig();
}

function buildView(projectName: string): SecretsResponse {
  const cfg = loadConfig();
  const secretsProjectName = resolveSecretsProjectName(cfg, projectName);
  const secretsCfg = loadSecretsOrEmpty();
  const project = secretsCfg.projects[secretsProjectName];

  if (!project) {
    return {
      secretsProject: secretsProjectName,
      exists: false,
      secretNames: [],
      whitelist: [],
      configPath: SECRETS_CONFIG_PATH,
    };
  }

  const whitelist: WhitelistRuleView[] = (project.whitelist ?? []).map(rule => ({
    command: rule.command,
    files: Object.entries(rule.file_hashes ?? {}).map(([path, hash]) => buildFileEntry(path, hash)),
    allowed_env: rule.allowed_env ?? [],
    secrets: rule.secrets ?? [],
  }));

  return {
    secretsProject: secretsProjectName,
    exists: true,
    directory: project.directory,
    secretNames: Object.keys(project.secrets ?? {}),
    whitelist,
    configPath: SECRETS_CONFIG_PATH,
  };
}

function buildFileEntry(path: string, hash: string): FileEntryView {
  const resolved = resolvePath(path);
  if (!existsSync(resolved)) return { path, hash, exists: false };
  let currentHash: string | undefined;
  try { currentHash = sha256File(resolved); } catch { /* unreadable */ }
  return {
    path,
    hash,
    exists: true,
    currentHash,
    matches: currentHash !== undefined && currentHash === hash,
  };
}

function normalizeRuleInput(input: unknown): WhitelistRuleInput | { error: string } {
  if (typeof input !== 'object' || input === null) return { error: 'body must be an object' };
  const b = input as Record<string, unknown>;
  if (typeof b['command'] !== 'string' || b['command'].length === 0) {
    return { error: 'command must be a non-empty string' };
  }
  const filesRaw = b['files'];
  if (!Array.isArray(filesRaw)) return { error: 'files must be an array' };
  const files: { path: string }[] = [];
  for (let i = 0; i < filesRaw.length; i++) {
    const entry = filesRaw[i];
    if (typeof entry !== 'object' || entry === null) return { error: `files[${i}] must be an object` };
    const path = (entry as Record<string, unknown>)['path'];
    if (typeof path !== 'string' || path.length === 0) return { error: `files[${i}].path must be a non-empty string` };
    files.push({ path });
  }
  const allowedEnv = normalizeStringArray(b['allowed_env'], 'allowed_env');
  if ('error' in allowedEnv) return allowedEnv;
  const secrets = normalizeStringArray(b['secrets'], 'secrets');
  if ('error' in secrets) return secrets;
  return { command: b['command'] as string, files, allowed_env: allowedEnv.values, secrets: secrets.values };
}

function normalizeStringArray(value: unknown, field: string): { values: string[] } | { error: string } {
  if (value === undefined || value === null) return { values: [] };
  if (!Array.isArray(value)) return { error: `${field} must be an array` };
  for (let i = 0; i < value.length; i++) {
    if (typeof value[i] !== 'string') return { error: `${field}[${i}] must be a string` };
  }
  return { values: value as string[] };
}

/** Build the on-disk rule, computing hashes from the supplied paths. Missing
 *  files are returned in `missing` for a 400 response. */
function materializeRule(input: WhitelistRuleInput): { rule: WhitelistRule } | { missing: string[] } {
  const file_hashes: Record<string, string> = {};
  const missing: string[] = [];
  for (const { path } of input.files) {
    const resolved = resolvePath(path);
    if (!existsSync(resolved)) { missing.push(path); continue; }
    file_hashes[path] = sha256File(resolved);
  }
  if (missing.length > 0) return { missing };
  return {
    rule: {
      command: input.command,
      file_hashes,
      allowed_env: input.allowed_env ?? [],
      secrets: input.secrets ?? [],
    },
  };
}

export async function registerSecretsRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { p: string } }>(
    '/api/p/:p/secrets',
    async (req, reply) => {
      try {
        return buildView(req.params.p);
      } catch (err) {
        reply.code(500);
        return { error: (err as Error).message };
      }
    },
  );

  app.put<{ Params: { p: string }; Body: { secretsProject: string | null } }>(
    '/api/p/:p/secrets/secretsProject',
    async (req, reply) => {
      const value = req.body?.secretsProject;
      if (value !== null && (typeof value !== 'string' || value.length === 0)) {
        reply.code(400);
        return { error: 'body.secretsProject must be a non-empty string or null' };
      }
      try {
        updateConfig(cfg => {
          const entry = cfg.projects[req.params.p];
          if (!entry) throw new Error(`project "${req.params.p}" not in config`);
          if (value === null || value === req.params.p) delete entry.secretsProject;
          else entry.secretsProject = value;
        });
      } catch (err) {
        reply.code(404);
        return { error: (err as Error).message };
      }
      return buildView(req.params.p);
    },
  );

  app.post<{ Params: { p: string }; Body: unknown }>(
    '/api/p/:p/secrets/whitelist',
    async (req, reply) => {
      const norm = normalizeRuleInput(req.body);
      if ('error' in norm) { reply.code(400); return { error: norm.error }; }

      const cfg = loadConfig();
      const secretsProjectName = resolveSecretsProjectName(cfg, req.params.p);
      const secretsCfg = loadSecretsOrEmpty();
      const project = secretsCfg.projects[secretsProjectName];
      if (!project) {
        reply.code(404);
        return { error: `secrets project "${secretsProjectName}" not found in ${SECRETS_CONFIG_PATH}. Add an entry under \`projects:\` first.` };
      }

      const mat = materializeRule(norm);
      if ('missing' in mat) { reply.code(400); return { error: 'files missing', missing: mat.missing }; }

      project.whitelist = [...(project.whitelist ?? []), mat.rule];
      saveSecretsConfig(secretsCfg);
      return buildView(req.params.p);
    },
  );

  app.put<{ Params: { p: string; index: string }; Body: unknown }>(
    '/api/p/:p/secrets/whitelist/:index',
    async (req, reply) => {
      const idx = Number.parseInt(req.params.index, 10);
      if (!Number.isInteger(idx) || idx < 0) { reply.code(400); return { error: 'invalid index' }; }
      const norm = normalizeRuleInput(req.body);
      if ('error' in norm) { reply.code(400); return { error: norm.error }; }

      const cfg = loadConfig();
      const secretsProjectName = resolveSecretsProjectName(cfg, req.params.p);
      const secretsCfg = loadSecretsOrEmpty();
      const project = secretsCfg.projects[secretsProjectName];
      if (!project) { reply.code(404); return { error: `secrets project "${secretsProjectName}" not found` }; }
      const list = project.whitelist ?? [];
      if (idx >= list.length) { reply.code(404); return { error: `rule index ${idx} out of range` }; }

      const mat = materializeRule(norm);
      if ('missing' in mat) { reply.code(400); return { error: 'files missing', missing: mat.missing }; }

      list[idx] = mat.rule;
      project.whitelist = list;
      saveSecretsConfig(secretsCfg);
      return buildView(req.params.p);
    },
  );

  app.delete<{ Params: { p: string; index: string } }>(
    '/api/p/:p/secrets/whitelist/:index',
    async (req, reply) => {
      const idx = Number.parseInt(req.params.index, 10);
      if (!Number.isInteger(idx) || idx < 0) { reply.code(400); return { error: 'invalid index' }; }

      const cfg = loadConfig();
      const secretsProjectName = resolveSecretsProjectName(cfg, req.params.p);
      const secretsCfg = loadSecretsOrEmpty();
      const project = secretsCfg.projects[secretsProjectName];
      if (!project) { reply.code(404); return { error: `secrets project "${secretsProjectName}" not found` }; }
      const list = project.whitelist ?? [];
      if (idx >= list.length) { reply.code(404); return { error: `rule index ${idx} out of range` }; }

      list.splice(idx, 1);
      project.whitelist = list;
      saveSecretsConfig(secretsCfg);
      return buildView(req.params.p);
    },
  );

  // Preview-only: compute a hash for a path before saving a rule. Used by
  // the dialog to validate paths as the user types.
  app.post<{ Params: { p: string }; Body: { path?: unknown } }>(
    '/api/p/:p/secrets/hash',
    async (req, reply) => {
      const path = req.body?.path;
      if (typeof path !== 'string' || path.length === 0) {
        reply.code(400);
        return { error: 'body.path must be a non-empty string' };
      }
      const resolved = pathResolve(resolvePath(path));
      if (!existsSync(resolved)) return { path, exists: false };
      try {
        return { path, exists: true, hash: sha256File(resolved) };
      } catch (err) {
        reply.code(500);
        return { error: (err as Error).message };
      }
    },
  );
}
