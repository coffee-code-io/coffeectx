import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

export const LSP_CONFIG_PATH = join(homedir(), '.coffeecode', 'lsp.yaml');
export const DEFAULT_LSP_COMMAND = 'typescript-language-server --stdio';

interface RawCommandConfig {
  command?: unknown;
  args?: unknown;
}

interface RawLspConfig {
  default?: unknown;
  command?: unknown;
  args?: unknown;
  servers?: unknown;
}

export interface LspConfig {
  defaultCommand: string;
  servers: Record<string, string>;
}

function toCommandString(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
}

function toArgs(args: unknown): string[] {
  if (!Array.isArray(args)) return [];
  return args.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
}

function parseCommandConfig(value: unknown): string | null {
  const fromString = toCommandString(value);
  if (fromString) return fromString;

  if (!value || typeof value !== 'object') return null;
  const cfg = value as RawCommandConfig;
  const command = toCommandString(cfg.command);
  if (!command) return null;

  const args = toArgs(cfg.args);
  return args.length > 0 ? `${command} ${args.join(' ')}` : command;
}

function parseServers(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') return {};

  const servers: Record<string, string> = {};
  for (const [name, cfg] of Object.entries(value as Record<string, unknown>)) {
    const cmd = parseCommandConfig(cfg);
    if (!cmd) continue;
    servers[name] = cmd;
  }
  return servers;
}

export function loadLspConfig(): LspConfig {
  if (!existsSync(LSP_CONFIG_PATH)) {
    return { defaultCommand: DEFAULT_LSP_COMMAND, servers: {} };
  }

  try {
    const raw = readFileSync(LSP_CONFIG_PATH, 'utf-8');
    const parsed = parseYaml(raw) as RawLspConfig | null;
    if (!parsed || typeof parsed !== 'object') {
      return { defaultCommand: DEFAULT_LSP_COMMAND, servers: {} };
    }

    const defaultCommand =
      parseCommandConfig(parsed.default) ??
      parseCommandConfig({ command: parsed.command, args: parsed.args }) ??
      DEFAULT_LSP_COMMAND;

    return {
      defaultCommand,
      servers: parseServers(parsed.servers),
    };
  } catch {
    return { defaultCommand: DEFAULT_LSP_COMMAND, servers: {} };
  }
}

export function resolveLspCommand(explicitCommand?: string, language = 'typescript'): string {
  if (explicitCommand && explicitCommand.trim().length > 0) return explicitCommand;

  const cfg = loadLspConfig();
  const byLanguage = cfg.servers[language];
  if (byLanguage) return byLanguage;

  return cfg.defaultCommand;
}
