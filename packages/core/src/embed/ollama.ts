import type { EmbedFn } from '../types.js';

export interface OllamaEmbedConfig {
  baseUrl?: string;
  model?: string;
  /** Target embedding dimension. Defaults to 1536. */
  dimensions?: number;
}

/**
 * Create an EmbedFn backed by a local Ollama instance.
 * Returns a Float32Array of `dimensions` length (default 1536), truncated or padded as needed.
 */
export function createOllamaEmbed(cfg: OllamaEmbedConfig): EmbedFn {
  const base = cfg.baseUrl ?? 'http://localhost:11434';
  const model = cfg.model ?? 'nomic-embed-text';
  const dims = cfg.dimensions ?? 1536;

  return async (text: string): Promise<Float32Array> => {
    const res = await fetch(`${base}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: text }),
    });

    if (!res.ok) throw new Error(`Ollama embed error: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { embeddings: number[][] };
    const raw = json.embeddings[0]!;

    if (raw.length === dims) return new Float32Array(raw);

    const vec = new Float32Array(dims);
    for (let i = 0; i < Math.min(raw.length, dims); i++) vec[i] = raw[i]!;
    return vec;
  };
}
