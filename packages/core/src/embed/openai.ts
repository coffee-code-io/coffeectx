import OpenAI from 'openai';
import type { EmbedFn } from '../types.js';

export interface OpenAIEmbedConfig {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

/**
 * Create an EmbedFn backed by any OpenAI-compatible embeddings API.
 *
 * Supports:
 *   - OpenAI (default baseUrl)
 *   - OpenRouter (pass baseUrl = OPENROUTER_BASE or use createOpenRouterEmbed)
 *   - Any other OpenAI-compatible endpoint
 *
 * Always returns a 128-dim Float32Array (truncated or padded as needed).
 * For text-embedding-3-* models the `dimensions: 128` parameter is used so
 * the model itself truncates — no precision is lost by post-hoc cropping.
 */
export function createOpenAIEmbed(cfg: OpenAIEmbedConfig): EmbedFn {
  const apiKey = cfg.apiKey ?? process.env['OPENAI_API_KEY'];
  if (!apiKey) throw new Error('embed.apiKey or OPENAI_API_KEY required');

  const model = cfg.model ?? 'text-embedding-3-small';
  const client = new OpenAI({ apiKey, baseURL: cfg.baseUrl });

  // text-embedding-3-* supports the dimensions parameter for native truncation.
  const nativeDims = model.startsWith('text-embedding-3');

  return async (text: string): Promise<Float32Array> => {
    const response = await client.embeddings.create({
      model,
      input: text,
      ...(nativeDims ? { dimensions: 128 } : {}),
    });

    const raw = response.data[0]!.embedding;
    if (raw.length === 128) return new Float32Array(raw);

    // Truncate or pad to 128 dims for models that return a different size.
    const vec = new Float32Array(128);
    for (let i = 0; i < Math.min(raw.length, 128); i++) vec[i] = raw[i]!;
    return vec;
  };
}

/** Convenience wrapper: createOpenAIEmbed pre-configured for OpenRouter. */
export function createOpenRouterEmbed(cfg: Omit<OpenAIEmbedConfig, 'baseUrl'>): EmbedFn {
  return createOpenAIEmbed({
    ...cfg,
    baseUrl: OPENROUTER_BASE,
    model: cfg.model ?? 'openai/text-embedding-3-small',
  });
}
