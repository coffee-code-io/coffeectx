import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { EmbedFn } from '../types.js';
import { createOpenAIEmbed, createOpenRouterEmbed } from './openai.js';
import { createOllamaEmbed } from './ollama.js';

export { createOpenAIEmbed, createOpenRouterEmbed } from './openai.js';
export { createOllamaEmbed } from './ollama.js';

export type EmbedProvider = 'stub' | 'openai' | 'openrouter' | 'ollama';

export interface EmbedConfig {
  provider: EmbedProvider;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  /** Target embedding dimension. Defaults to 1536. */
  dimensions?: number;
}

/** Create a stub EmbedFn that returns a zero vector of the given dimension. */
export function makeStubEmbed(dims = 1536): EmbedFn {
  return () => Promise.resolve(new Float32Array(dims));
}

/** Stub that returns a 1536-dim zero vector — useful for tests and non-semantic indexing. */
export const stubEmbed: EmbedFn = makeStubEmbed(1536);

/**
 * Create an EmbedFn from a provider config object.
 * Throws if the provider requires credentials that are not present.
 */
export function createEmbedFn(cfg: EmbedConfig): EmbedFn {
  switch (cfg.provider) {
    case 'openai':
      return createOpenAIEmbed(cfg);
    case 'openrouter':
      return createOpenRouterEmbed(cfg);
    case 'ollama':
      return createOllamaEmbed(cfg);
    case 'stub':
    default:
      return makeStubEmbed(cfg.dimensions ?? 1536);
  }
}

const CONFIG_DIR = join(homedir(), '.coffeecode');
const CONFIG_PATH = join(CONFIG_DIR, 'config.yaml');
const AUTH_PATH = join(CONFIG_DIR, 'auth.yaml');

/**
 * Load the embed configuration from ~/.coffeecode/config.yaml (and auth.yaml for credentials).
 * Falls back to stub provider if no config exists.
 */
export function loadEmbedConfig(): EmbedConfig {
  let cfg: EmbedConfig = { provider: 'stub' };

  if (existsSync(CONFIG_PATH)) {
    try {
      const parsed = parse(readFileSync(CONFIG_PATH, 'utf-8')) as Record<string, unknown> | null;
      const embed = parsed?.['embed'] as Partial<EmbedConfig> | undefined;
      if (embed) cfg = { provider: 'stub', ...embed } as EmbedConfig;
    } catch { /* fall through to defaults */ }
  }

  // Fall back to auth.yaml for API credentials.
  if (!cfg.apiKey && existsSync(AUTH_PATH)) {
    try {
      const parsed = parse(readFileSync(AUTH_PATH, 'utf-8')) as Record<string, unknown> | null;
      const auth = (parsed?.['auth'] as Record<string, unknown> | undefined) ?? (parsed ?? {});
      if (!cfg.apiKey && auth['apiKey']) cfg.apiKey = auth['apiKey'] as string;
      if (!cfg.baseUrl && auth['baseUrl']) cfg.baseUrl = auth['baseUrl'] as string;
    } catch { /* ignore */ }
  }

  return cfg;
}
