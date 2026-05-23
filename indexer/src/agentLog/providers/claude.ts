/**
 * Claude Code provider — reads `~/.claude/projects/<encoded-cwd>/*.jsonl`.
 *
 * Each `.jsonl` is a single Claude Code session; lines we care about are
 * `{ type: 'user' | 'assistant', uuid, sessionId, timestamp, message: {...} }`.
 * The native shape is already the canonical `RawLogMessage` the rest of the
 * pipeline expects — we just wrap it in the provider contract.
 */

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readLogFile, deduplicateMessages, type RawLogMessage } from '../reader.js';
import { extractSessions } from '../classifier.js';
import {
  hasLogFileChanged,
  markLogFileIndexed,
  saveFileHashes,
} from '../../fileHashes.js';
import type {
  AgentLogProvider,
  ProviderScanOptions,
  ProviderScanResult,
  ScannedSession,
} from '../provider.js';

export interface ClaudeProviderOptions {
  /** Single file or directory of `.jsonl` logs. */
  paths: string[];
}

export class ClaudeProvider implements AgentLogProvider {
  readonly name = 'claude' as const;

  constructor(private readonly opts: ClaudeProviderOptions) {}

  async scan(options: ProviderScanOptions): Promise<ProviderScanResult> {
    const sessions = new Map<string, ScannedSession>();
    const allMessages: RawLogMessage[] = [];

    for (const filePath of resolveLogFiles(this.opts.paths)) {
      if (options.hashes && !hasLogFileChanged(filePath, options.hashes)) continue;

      let raw: RawLogMessage[];
      try {
        raw = await readLogFile(filePath);
      } catch {
        continue; // best-effort across files
      }
      const messages = deduplicateMessages(raw);

      // Namespace sessionIds so they can't collide with codex/pi.
      for (const m of messages) m.sessionId = `claude:${m.sessionId}`;

      // Extract session metadata BEFORE filtering messages by newerThan, since
      // a session's startTime comes from its earliest message.
      const localSessions = extractSessions(messages);
      for (const [sid, meta] of localSessions) {
        if (options.newerThan && new Date(meta.startTime) < options.newerThan) continue;
        if (!sessions.has(sid)) {
          sessions.set(sid, {
            sessionId: sid,
            cwd: meta.cwd,
            startTime: meta.startTime,
            model: meta.model,
            provider: 'claude',
          });
        }
      }

      allMessages.push(...messages);

      if (options.hashes) {
        markLogFileIndexed(filePath, options.hashes);
        saveFileHashes(options.hashes);
      }
    }

    return { sessions, messages: allMessages };
  }
}

/** Collect .jsonl file paths from a mix of file and directory paths. */
function resolveLogFiles(paths: string[]): string[] {
  const files: string[] = [];
  for (const p of paths) {
    let stat;
    try { stat = statSync(p); } catch { continue; }
    if (stat.isFile()) {
      if (p.endsWith('.jsonl')) files.push(p);
    } else if (stat.isDirectory()) {
      for (const entry of readdirSync(p)) {
        if (entry.endsWith('.jsonl')) files.push(join(p, entry));
      }
    }
  }
  return files;
}
