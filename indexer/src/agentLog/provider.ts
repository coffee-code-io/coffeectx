/**
 * Provider abstraction for agent-session indexing.
 *
 * Each coding-agent vendor stores its session history in a different place /
 * shape. The contract here is the smallest thing that lets a single downstream
 * pipeline (classify → enrich → upsert) handle all of them.
 *
 * A provider's job is just to surface its sessions in the `RawLogMessage`
 * shape that the existing classifier already understands. From the classifier
 * downward everything is provider-agnostic.
 */

import type { RawLogMessage } from './reader.js';
import type { FileHashStore } from '../fileHashes.js';

export interface ScannedSession {
  /** Provider-namespaced session id (e.g. "claude:<uuid>" or "codex:<thread>"). */
  sessionId: string;
  /** Working directory when the session was created. */
  cwd?: string;
  /** ISO timestamp of the first message. */
  startTime: string;
  /** Provider-reported model id, when known. */
  model?: string;
  /** Provider name — duplicated here so callers don't need to thread it. */
  provider: ProviderName;
}

export type ProviderName = 'claude' | 'codex' | 'pi';

export interface ProviderScanOptions {
  /** Only emit sessions whose startTime is at or after this date. */
  newerThan?: Date;
  /** Optional file-hash store for change detection across runs. */
  hashes?: FileHashStore;
}

export interface ProviderScanResult {
  sessions: Map<string, ScannedSession>;
  /** Messages normalised to the Claude-shaped RawLogMessage so the existing
   *  `classifyMessages` and `extractSessions` work unchanged. `sessionId` on
   *  each message MUST match the namespaced id in `sessions`. */
  messages: RawLogMessage[];
}

export interface AgentLogProvider {
  /** Stable provider name; used for AgentSession.provider and logging. */
  readonly name: ProviderName;
  /** Scan storage and produce normalised data ready for indexing. */
  scan(options: ProviderScanOptions): Promise<ProviderScanResult>;
}
