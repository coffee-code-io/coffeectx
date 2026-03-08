import OpenAI from 'openai';
import type { EmbedFn } from '../types.js';

export interface OpenAIEmbedConfig {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  /** Target embedding dimension. Defaults to 1536 (native size of text-embedding-3-small). */
  dimensions?: number;
}

const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

import { appendFileSync } from 'node:fs';

/**
 * Create an EmbedFn backed by any OpenAI-compatible embeddings API.
 *
 * Supports:
 *   - OpenAI (default baseUrl)
 *   - OpenRouter (pass baseUrl = OPENROUTER_BASE or use createOpenRouterEmbed)
 *   - Any other OpenAI-compatible endpoint
 *
 * Returns a Float32Array of `dimensions` length (default 1536).
 * For text-embedding-3-* models the `dimensions` parameter is passed so
 * the model truncates natively — no precision loss from post-hoc cropping.
 * For other models the vector is truncated or padded to the target size.
 */
export function createOpenAIEmbed(cfg: OpenAIEmbedConfig): EmbedFn {
  const apiKey = cfg.apiKey ?? process.env['OPENAI_API_KEY'];
  if (!apiKey) throw new Error('embed.apiKey or OPENAI_API_KEY required');

  const model = cfg.model ?? 'text-embedding-3-small';
  const dims = cfg.dimensions ?? 1536;
  const client = new OpenAI({ apiKey, baseURL: cfg.baseUrl });

  // text-embedding-3-* (direct) and openai/text-embedding-3-* (via OpenRouter)
  // support the dimensions parameter for native truncation.
  const supportsNativeDims =
    model.startsWith('text-embedding-3') || model.includes('/text-embedding-3');

var _diagLine = `[mcp] embed gen ${model} dims=${dims} native=${supportsNativeDims}\n`;
try { appendFileSync('/tmp/retrival-mcp-diag.log', _diagLine); } catch { /* ignore */ }


  return async (text: string): Promise<Float32Array> => {
var _diagLine = `[mcp] call resp ${text}\n`;
try { appendFileSync('/tmp/retrival-mcp-diag.log', _diagLine); } catch { /* ignore */ }


    const response = await client.embeddings.create({
      model,
      input: text,
      ...(supportsNativeDims ? { dimensions: dims } : {}),
    });

var _diagLine = `[mcp] embed resp ${response}\n`;
try { appendFileSync('/tmp/retrival-mcp-diag.log', _diagLine); } catch { /* ignore */ }


    const raw = response.data[0]!.embedding;
    if (raw.length === dims) return new Float32Array(raw);

    // Truncate or pad to target dims for models that return a different size.
    const vec = new Float32Array(dims);
    for (let i = 0; i < Math.min(raw.length, dims); i++) vec[i] = raw[i]!;
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
