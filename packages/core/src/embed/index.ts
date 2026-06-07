/**
 * Embed factory. One entry point: `createEmbedFn(EmbedSettings)`.
 *
 * Embedding uses the same `AuthSettings` schema as every other LLM
 * credential block in coffeectx (the shape lives in `../auth.ts`). When
 * `auth` is omitted the factory returns a stub that emits zero vectors —
 * useful for projects that don't want semantic search.
 *
 * Supported `auth` shapes for embeddings:
 *
 *   - `authType: apiKey` + `provider: openai | openrouter` → OpenAI-compatible
 *     embeddings client pointed at the alias's base URL.
 *   - `authType: apiKey` + `url: <custom>` → same client, custom base URL.
 *   - `authType: apiKey` + `provider: anthropic` → rejected: Anthropic has no
 *     embeddings API.
 *   - `authType: openai-oauth` → rejected: OAuth-only Codex flow doesn't
 *     authorize the embeddings endpoint.
 */

import type { EmbedFn } from '../types.js';
import type { EmbedSettings } from '../config.js';
import { resolveAuth, type AuthSettings } from '../auth.js';
import { createOpenAIEmbed } from './openai.js';

export { createOpenAIEmbed, createOpenRouterEmbed } from './openai.js';

const DEFAULT_DIMS = 128;

/** Stub EmbedFn that returns a zero vector of the given dimension. Used as
 *  the fallback when a project doesn't configure embeddings. */
export function makeStubEmbed(dims = DEFAULT_DIMS): EmbedFn {
  return () => Promise.resolve(new Float32Array(dims));
}

/**
 * Build an EmbedFn from an `EmbedSettings` block. Throws on unsupported
 * auth shapes (Anthropic, OAuth) so the error surfaces at startup rather
 * than the first embedding call.
 */
export function createEmbedFn(cfg: EmbedSettings): EmbedFn {
  const dims = cfg.dimensions ?? DEFAULT_DIMS;
  if (!cfg.auth) return makeStubEmbed(dims);

  const auth: AuthSettings = cfg.auth;
  if (auth.authType === 'openai-oauth') {
    throw new Error('embed.auth: openai-oauth is not supported for embeddings — set authType: apiKey.');
  }
  if (auth.authType === 'apiKey' && auth.provider === 'anthropic') {
    throw new Error('embed.auth: Anthropic has no embeddings API — use provider: openai or openrouter, or set a custom url.');
  }

  const resolved = resolveAuth(auth);
  return createOpenAIEmbed({
    apiKey: resolved.apiKey,
    model: resolved.model,
    baseUrl: resolved.baseUrl,
    dimensions: dims,
  });
}
