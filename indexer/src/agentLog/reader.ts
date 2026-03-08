import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

export type RawContent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: unknown[] };

export interface RawLogMessage {
  type: 'user' | 'assistant';
  uuid: string;
  parentUuid: string | null;
  sessionId: string;
  timestamp: string;
  cwd?: string;
  message: {
    role: string;
    model?: string;
    id?: string;
    content: RawContent[];
  };
}

/**
 * Stream-parse a Claude Code JSONL session log.
 * Only returns "user" and "assistant" type entries; skips queue-operation,
 * file-history-snapshot, and any other internal bookkeeping entries.
 */
export async function readLogFile(path: string): Promise<RawLogMessage[]> {
  const rl = createInterface({
    input: createReadStream(path, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });

  const messages: RawLogMessage[] = [];
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue; // skip malformed lines
    }
    if (obj.type === 'user' || obj.type === 'assistant') {
      messages.push(obj as unknown as RawLogMessage);
    }
  }
  return messages;
}

/**
 * Deduplicate messages by UUID — Claude sometimes emits the same message multiple
 * times as it streams partial content. Keep the last occurrence (most complete).
 */
export function deduplicateMessages(messages: RawLogMessage[]): RawLogMessage[] {
  const seen = new Map<string, RawLogMessage>();
  for (const msg of messages) {
    seen.set(msg.uuid, msg);
  }
  return Array.from(seen.values());
}
