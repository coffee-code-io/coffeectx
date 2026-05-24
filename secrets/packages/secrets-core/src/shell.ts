import fs from 'node:fs';
import path from 'node:path';

const BUILTINS = new Set([
  'alias',
  'bg',
  'break',
  'cd',
  'continue',
  'dirs',
  'echo',
  'eval',
  'exec',
  'exit',
  'export',
  'false',
  'fg',
  'hash',
  'jobs',
  'popd',
  'printf',
  'pushd',
  'pwd',
  'read',
  'readonly',
  'return',
  'set',
  'shift',
  'test',
  'times',
  'trap',
  'true',
  'type',
  'ulimit',
  'umask',
  'unalias',
  'unset',
]);

export interface CommandAnalysis {
  executablePaths: string[];
  complex: boolean;
  reason?: string;
}

export function analyzeBashCommand(command: string, options: { cwd: string; env?: NodeJS.ProcessEnv }): CommandAnalysis {
  if (/[`]|[$][(]|[<][(]|[>][(]/.test(command)) {
    return { executablePaths: [], complex: true, reason: 'command substitution and process substitution are not hash-verifiable' };
  }

  const segments = splitCommandSegments(command);
  if (segments.complex) return { executablePaths: [], complex: true, reason: segments.reason };

  const executablePaths: string[] = [];
  for (const segment of segments.parts) {
    const tokens = tokenizeSimple(segment);
    if (tokens.complex) return { executablePaths, complex: true, reason: tokens.reason };
    const executable = firstExecutableToken(tokens.tokens);
    if (!executable || BUILTINS.has(executable)) continue;
    executablePaths.push(resolveExecutable(executable, options.cwd, options.env?.PATH ?? process.env.PATH ?? ''));
  }

  return { executablePaths: [...new Set(executablePaths)], complex: false };
}

function splitCommandSegments(command: string): { parts: string[]; complex: boolean; reason?: string } {
  const parts: string[] = [];
  let current = '';
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      current += ch;
      escaped = true;
      continue;
    }
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      current += ch;
      quote = ch;
      continue;
    }
    if (ch === '&' && command[i + 1] !== '&') {
      return { parts: [], complex: true, reason: 'background execution is not hash-verifiable' };
    }
    if (ch === '|' || ch === ';' || ch === '\n' || (ch === '&' && command[i + 1] === '&')) {
      if (current.trim()) parts.push(current.trim());
      current = '';
      if (ch === '&') i++;
      if (ch === '|' && command[i + 1] === '|') i++;
      continue;
    }
    current += ch;
  }

  if (quote) return { parts: [], complex: true, reason: 'unterminated quote' };
  if (current.trim()) parts.push(current.trim());
  return { parts, complex: false };
}

function tokenizeSimple(segment: string): { tokens: string[]; complex: boolean; reason?: string } {
  const tokens: string[] = [];
  let current = '';
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!;
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === '<' || ch === '>') return { tokens: [], complex: true, reason: 'redirection is not hash-verifiable' };
    if (/\s/.test(ch)) {
      if (current) tokens.push(current);
      current = '';
      continue;
    }
    current += ch;
  }

  if (quote) return { tokens: [], complex: true, reason: 'unterminated quote' };
  if (current) tokens.push(current);
  return { tokens, complex: false };
}

function firstExecutableToken(tokens: string[]): string | null {
  for (const token of tokens) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token)) continue;
    if (token === 'env') continue;
    return token;
  }
  return null;
}

function resolveExecutable(executable: string, cwd: string, pathEnv: string): string {
  if (executable.includes('/')) {
    const resolved = path.isAbsolute(executable) ? executable : path.resolve(cwd, executable);
    if (!isExecutableFile(resolved)) throw new Error(`Executable "${executable}" not found or not executable`);
    return resolved;
  }

  for (const entry of pathEnv.split(path.delimiter)) {
    if (!entry) continue;
    const candidate = path.join(entry, executable);
    if (isExecutableFile(candidate)) return candidate;
  }
  throw new Error(`Executable "${executable}" not found in PATH`);
}

function isExecutableFile(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
