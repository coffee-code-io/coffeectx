import path from 'node:path';
import { resolvePath, resolveProject } from './config.js';
import { sha256File } from './hash.js';
import { analyzeBashCommand } from './shell.js';
import type { ExecElevatedRequest, ProjectConfig, SecretsConfig, ValidationResult, WhitelistRule } from './types.js';

const BASH_PATH = '/bin/bash';

export function validateExecRequest(
  config: SecretsConfig,
  request: ExecElevatedRequest,
  options: { approveUnmatched?: boolean; env?: NodeJS.ProcessEnv } = {},
): ValidationResult {
  if (!request.command.trim()) throw new Error('command must not be empty');
  if (!Array.isArray(request.secrets)) throw new Error('secrets must be an array');

  const { projectName, project } = resolveProject(config, {
    cwd: request.cwd,
    projectName: request.project,
    env: options.env,
  });
  const cwd = resolvePath(request.cwd ?? project.directory);
  const rules = project.whitelist ?? [];
  const matched = rules.find((rule) => commandMatches(rule, request.command));

  if (!matched) {
    if (options.approveUnmatched) {
      const analysis = analyzeBashCommand(request.command, { cwd, env: options.env });
      return {
        status: 'unmatched',
        projectName,
        project,
        warning: 'Command did not match any whitelist rule and was allowed by explicit approval',
        executablePaths: analysis.executablePaths,
      };
    }
    return {
      status: 'unmatched',
      projectName,
      project,
      warning: 'Command did not match any whitelist rule',
      executablePaths: [],
    };
  }

  const envNames = Object.keys(request.env ?? {});
  const allowedEnv = new Set(matched.allowed_env ?? []);
  const disallowedEnv = envNames.filter((name) => !allowedEnv.has(name));
  if (disallowedEnv.length > 0) {
    return rejected(projectName, project, matched, `Command requested env vars not allowed by whitelist: ${disallowedEnv.join(', ')}`);
  }

  const allowedSecrets = new Set(matched.secrets ?? []);
  const disallowedSecrets = request.secrets.filter((name) => !allowedSecrets.has(name));
  if (disallowedSecrets.length > 0) {
    return rejected(projectName, project, matched, `Command requested secrets not allowed by whitelist: ${disallowedSecrets.join(', ')}`);
  }

  const hashResult = validateHashes(matched, request.command, cwd, options.env);
  if (!hashResult.ok) return rejected(projectName, project, matched, hashResult.warning, hashResult.executablePaths);

  return {
    status: 'allowed',
    projectName,
    project,
    matchedRule: matched,
    executablePaths: hashResult.executablePaths,
  };
}

function commandMatches(rule: WhitelistRule, command: string): boolean {
  try {
    return new RegExp(rule.command).test(command);
  } catch (err) {
    throw new Error(`Invalid whitelist command regex "${rule.command}": ${(err as Error).message}`);
  }
}

function validateHashes(
  rule: WhitelistRule,
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv | undefined,
): { ok: true; executablePaths: string[] } | { ok: false; warning: string; executablePaths: string[] } {
  const configured = normalizeFileHashes(rule.file_hashes ?? {}, cwd);
  const analysis = analyzeBashCommand(command, { cwd, env });
  const configuredWithoutBash = [...configured.keys()].filter((file) => file !== BASH_PATH);

  if (analysis.complex && configuredWithoutBash.length > 0) {
    return {
      ok: false,
      warning: `Command uses shell syntax that cannot be hash-verified: ${analysis.reason ?? 'unsupported syntax'}`,
      executablePaths: analysis.executablePaths,
    };
  }

  const required = new Set<string>([BASH_PATH, ...analysis.executablePaths]);
  for (const file of required) {
    const expected = configured.get(file);
    if (!expected) {
      return {
        ok: false,
        warning: `Whitelist is missing sha256 hash for executable: ${file}`,
        executablePaths: [...required],
      };
    }
    const actual = sha256File(file);
    if (actual.toLowerCase() !== expected.toLowerCase()) {
      return {
        ok: false,
        warning: `Executable hash mismatch for: ${file}`,
        executablePaths: [...required],
      };
    }
  }

  for (const file of configured.keys()) {
    if (!required.has(file)) {
      const actual = sha256File(file);
      const expected = configured.get(file)!;
      if (actual.toLowerCase() !== expected.toLowerCase()) {
        return {
          ok: false,
          warning: `Configured file hash mismatch for: ${file}`,
          executablePaths: [...required],
        };
      }
    }
  }

  return { ok: true, executablePaths: [...required] };
}

function normalizeFileHashes(fileHashes: Record<string, string>, cwd: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const [file, hash] of Object.entries(fileHashes)) {
    const resolved = file === BASH_PATH ? BASH_PATH : path.resolve(resolvePath(file, cwd));
    result.set(resolved, hash);
  }
  return result;
}

function rejected(
  projectName: string,
  project: ProjectConfig,
  rule: WhitelistRule,
  warning: string,
  executablePaths: string[] = [],
): ValidationResult {
  return {
    status: 'rejected',
    projectName,
    project,
    matchedRule: rule,
    warning,
    executablePaths,
  };
}
