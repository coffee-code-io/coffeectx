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
}

/** Stub that returns a zero vector — useful for tests and non-semantic indexing. */
export const stubEmbed: EmbedFn = () => Promise.resolve(new Float32Array(128));

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
      return stubEmbed;
  }
}
