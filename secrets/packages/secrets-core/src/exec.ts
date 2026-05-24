import { spawn } from 'node:child_process';
import { resolvePath, loadSecretsConfig } from './config.js';
import { resolveSecrets } from './secrets.js';
import { validateExecRequest } from './validate.js';
import type { ExecElevatedOptions, ExecElevatedRequest, ExecElevatedResult } from './types.js';

export async function execElevated(
  request: ExecElevatedRequest,
  options: ExecElevatedOptions = {},
): Promise<ExecElevatedResult> {
  const started = Date.now();
  const baseEnv = options.baseEnv ?? process.env;
  const config = loadSecretsConfig(options.configPath);
  const validation = validateExecRequest(config, request, {
    approveUnmatched: options.approveUnmatched,
    env: baseEnv,
  });

  if (validation.status === 'rejected' || (validation.status === 'unmatched' && !options.approveUnmatched)) {
    return {
      ok: false,
      project: validation.projectName,
      matchedRule: validation.matchedRule?.command,
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
      durationMs: Date.now() - started,
      warning: validation.warning,
    };
  }

  const cwd = resolvePath(request.cwd ?? validation.project.directory);
  const secretEnv = await resolveSecrets(validation.project, request.secrets, {
    projectDirectory: resolvePath(validation.project.directory),
    baseEnv,
  });
  const childEnv: NodeJS.ProcessEnv = {
    ...baseEnv,
    ...(request.env ?? {}),
    ...secretEnv,
  };

  const result = await runBash(request.command, cwd, childEnv);
  return {
    ok: result.exitCode === 0,
    project: validation.projectName,
    matchedRule: validation.matchedRule?.command,
    approvedUnmatched: validation.status === 'unmatched',
    exitCode: result.exitCode,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: Date.now() - started,
    warning: validation.warning,
  };
}

function runBash(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/bash', ['-lc', command], { cwd, env });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (exitCode, signal) => {
      resolve({
        exitCode,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}
