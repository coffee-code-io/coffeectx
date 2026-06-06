/**
 * Shared bits used by every pi.dev-backed runner (`runUserJob`,
 * `runSpanIndexer`) — repo root constant + the terminal-provider-error
 * carrier type. Lives in its own module so we don't have to keep a
 * defunct runner around just for these exports.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** The skill commands run with the indexer repo as the working directory. */
export const PROJECT_ROOT = resolve(__dirname, '../../..');

/**
 * Thrown by the runners when the LLM provider returns a terminal error
 * (402 credits exhausted, 429 after retries, 5xx). Pi-coding-agent does
 * NOT throw on those — it resolves prompt() with the error surfaced as
 * the assistant's final text and `willRetry: false` on `agent_end`.
 * Wrapping into this distinct class lets the scheduler tag the run as
 * a provider failure rather than a generic error.
 */
export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderError';
  }
}
