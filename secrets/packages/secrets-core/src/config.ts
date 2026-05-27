import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import type { ProjectConfig, SecretProviderConfig, SecretsConfig, WhitelistRule } from './types.js';

export const DEFAULT_CONFIG_PATH = '~/.coffeecode/secrets.yaml';

export function expandHome(input: string): string {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/')) return path.join(os.homedir(), input.slice(2));
  return input;
}

export function resolvePath(input: string, baseDir?: string): string {
  const expanded = expandHome(input);
  if (path.isAbsolute(expanded)) return path.normalize(expanded);
  return path.resolve(baseDir ?? process.cwd(), expanded);
}

export function loadSecretsConfig(configPath = DEFAULT_CONFIG_PATH): SecretsConfig {
  const file = resolvePath(configPath);
  const raw = fs.readFileSync(file, 'utf8');
  const parsed = parse(raw) as unknown;
  return normalizeConfig(parsed);
}

/**
 * Persist a normalized config to disk. Atomic via tmp+rename. Creates the
 * parent directory if missing. Empty `whitelist`/`secrets`/`allowed_env`
 * fields are dropped to keep the YAML tidy.
 */
export function saveSecretsConfig(config: SecretsConfig, configPath = DEFAULT_CONFIG_PATH): void {
  const file = resolvePath(configPath);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });

  const projects: Record<string, unknown> = {};
  for (const [name, project] of Object.entries(config.projects)) {
    const out: Record<string, unknown> = { directory: project.directory };
    if (project.whitelist && project.whitelist.length > 0) {
      out['whitelist'] = project.whitelist.map(rule => {
        const r: Record<string, unknown> = { command: rule.command };
        if (rule.file_hashes && Object.keys(rule.file_hashes).length > 0) r['file_hashes'] = rule.file_hashes;
        if (rule.allowed_env && rule.allowed_env.length > 0) r['allowed_env'] = rule.allowed_env;
        if (rule.secrets && rule.secrets.length > 0) r['secrets'] = rule.secrets;
        return r;
      });
    }
    if (project.secrets && Object.keys(project.secrets).length > 0) out['secrets'] = project.secrets;
    projects[name] = out;
  }

  const yamlText = stringify({ projects });
  const tmp = `${file}.tmp-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  fs.writeFileSync(tmp, yamlText, 'utf8');
  fs.renameSync(tmp, file);
}

export function normalizeConfig(value: unknown): SecretsConfig {
  if (!isRecord(value)) throw new Error('Secrets config must be a YAML object');
  const projectsValue = value['projects'];
  if (!isRecord(projectsValue)) throw new Error('Secrets config must define a projects object');

  const projects: Record<string, ProjectConfig> = {};
  for (const [name, rawProject] of Object.entries(projectsValue)) {
    if (!isRecord(rawProject)) throw new Error(`Project "${name}" must be an object`);
    const directory = asString(rawProject['directory'], `projects.${name}.directory`);
    const whitelist = rawProject['whitelist'] === undefined
      ? []
      : asArray(rawProject['whitelist'], `projects.${name}.whitelist`).map((rule, i) => normalizeRule(rule, `${name}.whitelist[${i}]`));
    const secrets = normalizeSecrets(rawProject['secrets'], name);
    projects[name] = { directory, whitelist, secrets };
  }

  return { projects };
}

export function resolveProject(
  config: SecretsConfig,
  options: { cwd?: string; projectName?: string; env?: NodeJS.ProcessEnv } = {},
): { projectName: string; project: ProjectConfig } {
  const explicit = options.projectName ?? options.env?.['COFFEECTX_SECRETS_PROJECT'] ?? process.env['COFFEECTX_SECRETS_PROJECT'];
  if (explicit) {
    const project = config.projects[explicit];
    if (!project) throw new Error(`Project "${explicit}" not found in secrets config`);
    return { projectName: explicit, project };
  }

  const cwd = resolvePath(options.cwd ?? process.cwd());
  let best: { name: string; project: ProjectConfig; dir: string } | null = null;
  for (const [name, project] of Object.entries(config.projects)) {
    const dir = resolvePath(project.directory);
    const rel = path.relative(dir, cwd);
    const contains = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    if (contains && (!best || dir.length > best.dir.length)) best = { name, project, dir };
  }

  if (!best) throw new Error(`No secrets project matches cwd "${cwd}"`);
  return { projectName: best.name, project: best.project };
}

function normalizeRule(value: unknown, context: string): WhitelistRule {
  if (!isRecord(value)) throw new Error(`${context} must be an object`);
  const command = asString(value['command'], `${context}.command`);
  const fileHashes = normalizeStringMap(value['file_hashes'], `${context}.file_hashes`);
  const allowedEnv = value['allowed_env'] === undefined
    ? []
    : asArray(value['allowed_env'], `${context}.allowed_env`).map((item, i) => asString(item, `${context}.allowed_env[${i}]`));
  const secrets = value['secrets'] === undefined
    ? []
    : asArray(value['secrets'], `${context}.secrets`).map((item, i) => asString(item, `${context}.secrets[${i}]`));
  return { command, file_hashes: fileHashes, allowed_env: allowedEnv, secrets };
}

function normalizeSecrets(value: unknown, projectName: string): Record<string, SecretProviderConfig> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error(`projects.${projectName}.secrets must be an object`);
  const result: Record<string, SecretProviderConfig> = {};
  for (const [name, rawSecret] of Object.entries(value)) {
    if (!isRecord(rawSecret)) throw new Error(`Secret "${name}" must be an object`);
    const provider = asString(rawSecret['provider'], `secrets.${name}.provider`);
    if (provider === 'env') throw new Error(`Secret "${name}" uses unsupported provider "env"`);
    if (provider === 'dotenv') {
      result[name] = {
        provider,
        file: asString(rawSecret['file'], `secrets.${name}.file`),
        key: rawSecret['key'] === undefined ? undefined : asString(rawSecret['key'], `secrets.${name}.key`),
      };
    } else if (provider === 'inline') {
      result[name] = { provider, value: asString(rawSecret['value'], `secrets.${name}.value`) };
    } else if (provider === 'command') {
      result[name] = {
        provider,
        command: asString(rawSecret['command'], `secrets.${name}.command`),
        cwd: rawSecret['cwd'] === undefined ? undefined : asString(rawSecret['cwd'], `secrets.${name}.cwd`),
      };
    } else {
      throw new Error(`Secret "${name}" has unsupported provider "${provider}"`);
    }
  }
  return result;
}

function normalizeStringMap(value: unknown, context: string): Record<string, string> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error(`${context} must be an object`);
  const result: Record<string, string> = {};
  for (const [key, val] of Object.entries(value)) result[key] = asString(val, `${context}.${key}`);
  return result;
}

function asString(value: unknown, context: string): string {
  if (typeof value !== 'string') throw new Error(`${context} must be a string`);
  return value;
}

function asArray(value: unknown, context: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${context} must be an array`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
