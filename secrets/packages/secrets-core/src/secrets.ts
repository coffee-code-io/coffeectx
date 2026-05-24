import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';
import { resolvePath } from './config.js';
import type { ProjectConfig, SecretProviderConfig } from './types.js';

const execFileAsync = promisify(execFile);

export async function resolveSecrets(
  project: ProjectConfig,
  names: string[],
  options: { projectDirectory?: string; baseEnv?: NodeJS.ProcessEnv } = {},
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const configured = project.secrets ?? {};
  for (const name of names) {
    const provider = configured[name];
    if (!provider) throw new Error(`Secret "${name}" is not configured`);
    result[name] = await resolveSecret(provider, name, options.projectDirectory ?? project.directory, options.baseEnv);
  }
  return result;
}

async function resolveSecret(
  provider: SecretProviderConfig,
  name: string,
  projectDirectory: string,
  baseEnv: NodeJS.ProcessEnv | undefined,
): Promise<string> {
  if (provider.provider === 'inline') return provider.value;

  if (provider.provider === 'dotenv') {
    const file = resolvePath(provider.file, projectDirectory);
    const parsed = parseDotenv(fs.readFileSync(file, 'utf8'));
    const key = provider.key ?? name;
    const value = parsed[key];
    if (value === undefined) throw new Error(`Secret "${name}" key "${key}" not found in dotenv file`);
    return value;
  }

  const cwd = provider.cwd ? resolvePath(provider.cwd, projectDirectory) : projectDirectory;
  const { stdout } = await execFileAsync('/bin/bash', ['-lc', provider.command], {
    cwd,
    env: baseEnv,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

export function parseDotenv(input: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of input.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
    if (!match) continue;
    const key = match[1]!;
    let value = match[2]!;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}
