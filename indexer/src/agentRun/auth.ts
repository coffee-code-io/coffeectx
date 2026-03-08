import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parse } from 'yaml';
import type { QueryOptions } from '@qwen-code/sdk';

export interface AuthConfig {
  /** Maps to QueryOptions.authType */
  authType?: 'openai' | 'anthropic' | 'qwen-oauth' | 'gemini' | 'vertex-ai';
  /** API key — forwarded as OPENAI_API_KEY env var */
  apiKey?: string;
  /** Model name — forwarded as QueryOptions.model */
  model?: string;
  /** Base URL — forwarded as OPENAI_BASE_URL env var */
  baseUrl?: string;
  /** Absolute path to a qwen CLI executable — overrides the auto-resolved packaged default */
  qwenPath?: string;
}

const AUTH_PATH = join(homedir(), '.coffeecode', 'auth.yaml');

/**
 * Load auth configuration from ~/.coffeecode/auth.yaml.
 * Returns an empty config if the file does not exist or cannot be parsed.
 */
export function loadAuth(): AuthConfig {
  if (!existsSync(AUTH_PATH)) return {};
  try {
    const raw = readFileSync(AUTH_PATH, 'utf-8');
    const parsed = (parse(raw) as Record<string, unknown>) ?? {};
    // Support both flat { authType, apiKey, ... } and nested { auth: { authType, ... } }
    const config = (parsed['auth'] as AuthConfig | undefined) ?? (parsed as AuthConfig);
    return config ?? {};
  } catch {
    return {};
  }
}

/**
 * Convert an AuthConfig to a partial QueryOptions object suitable for
 * merging into the options passed to query().
 */
export function authToQueryOptions(auth: AuthConfig): Partial<QueryOptions> {
  const env: Record<string, string> = {};
  if (auth.apiKey) env['OPENAI_API_KEY'] = auth.apiKey;
  if (auth.baseUrl) env['OPENAI_BASE_URL'] = auth.baseUrl;

  return {
    ...(auth.authType ? { authType: auth.authType } : {}),
    ...(auth.model ? { model: auth.model } : {}),
    ...(auth.qwenPath ? { pathToQwenExecutable: auth.qwenPath } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };
}
