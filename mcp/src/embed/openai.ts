import type { EmbedFn } from '@retrival-mcp/core';

interface OpenAIEmbedConfig {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}

export function createOpenAIEmbed(cfg: OpenAIEmbedConfig): EmbedFn {
  const apiKey = cfg.apiKey ?? process.env['OPENAI_API_KEY'];
  if (!apiKey) throw new Error('embed.apiKey or OPENAI_API_KEY required for openai provider');

  const model = cfg.model ?? 'text-embedding-3-small';
  const base = cfg.baseUrl ?? 'https://api.openai.com/v1';

  return async (text: string): Promise<Float32Array> => {
    const res = await fetch(`${base}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        input: text,
        // Request 128 dims via truncation (supported by text-embedding-3-*)
        dimensions: 128,
      }),
    });

    if (!res.ok) throw new Error(`OpenAI embeddings error: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { data: { embedding: number[] }[] };
    return new Float32Array(json.data[0]!.embedding);
  };
}
