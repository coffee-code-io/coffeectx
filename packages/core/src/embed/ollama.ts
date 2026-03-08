import type { EmbedFn } from '../types.js';

export interface OllamaEmbedConfig {
  baseUrl?: string;
  model?: string;
}

/**
 * Create an EmbedFn backed by a local Ollama instance.
 * Always returns a 128-dim Float32Array (truncated or padded).
 */
export function createOllamaEmbed(cfg: OllamaEmbedConfig): EmbedFn {
  const base = cfg.baseUrl ?? 'http://localhost:11434';
  const model = cfg.model ?? 'nomic-embed-text';

  return async (text: string): Promise<Float32Array> => {
    const res = await fetch(`${base}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: text }),
    });

    if (!res.ok) throw new Error(`Ollama embed error: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { embeddings: number[][] };
    const raw = json.embeddings[0]!;

    if (raw.length === 128) return new Float32Array(raw);

    const vec = new Float32Array(128);
    for (let i = 0; i < Math.min(raw.length, 128); i++) vec[i] = raw[i]!;
    return vec;
  };
}
