/**
 * pi.dev provider — scans `@earendil-works/pi-coding-agent` session JSONL files.
 *
 * Layout: one `.jsonl` file per session, found at arbitrary user-configured
 * paths. Line 1 is `{ type: 'session', version, id, timestamp, cwd }`. Each
 * subsequent line is one of:
 *   - `message`               — actual conversation turn (we keep)
 *   - `model_change`          — switches active model (we track for AgentSession.model)
 *   - `thinking_level_change` / `compaction` / `branch_summary` /
 *     `custom` / `customMessage` / `label` / `sessionInfo`   (we skip)
 *
 * Pi's `message` shape differs from Anthropic's:
 *   `role: 'user' | 'assistant' | 'toolResult'` — `toolResult` is its own role,
 *     not a `user` message containing tool_result blocks.
 *   Content blocks: `text`, `thinking`, `toolCall` (Anthropic calls it `tool_use`).
 *
 * We normalise into the `RawLogMessage` shape so the existing classifier
 * handles everything downstream.
 */

import { createReadStream, statSync, readdirSync, realpathSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, resolve, basename } from 'node:path';
import { COFFEECODE_DIR } from '@coffeectx/core';
import type { RawContent, RawLogMessage } from '../reader.js';
import type {
  AgentLogProvider,
  ProviderScanOptions,
  ProviderScanResult,
  ScannedSession,
} from '../provider.js';

export interface PiProviderOptions {
  /** Root directory to scan for `.jsonl` session files (recursive). */
  sessionsPath: string;
}

/**
 * Always-excluded directories — the indexer's OWN skill-job sessions live
 * under `~/.coffeecode/sessions/`; indexing them creates a feedback loop.
 */
const ALWAYS_EXCLUDE_DIRS = new Set<string>([
  realpathOrSelf(join(COFFEECODE_DIR, 'sessions')),
]);

function realpathOrSelf(p: string): string {
  try { return realpathSync(p); } catch { return resolve(p); }
}

export class PiProvider implements AgentLogProvider {
  readonly name = 'pi' as const;

  constructor(private readonly opts: PiProviderOptions) {}

  async scan(options: ProviderScanOptions): Promise<ProviderScanResult> {
    const sessions = new Map<string, ScannedSession>();
    const messages: RawLogMessage[] = [];

    const root = resolve(this.opts.sessionsPath);
    let canonicalRoot: string;
    try { canonicalRoot = realpathSync(root); }
    catch { return { sessions, messages }; }

    // Refuse to index our own skill-job sessions even if the path is misconfigured.
    for (const excluded of ALWAYS_EXCLUDE_DIRS) {
      if (canonicalRoot === excluded || canonicalRoot.startsWith(excluded + '/')) {
        console.warn(`[pi-provider] sessionsPath "${root}" is inside ${excluded} — refusing to index our own sessions`);
        return { sessions, messages };
      }
    }

    const files = collectJsonlRecursive(canonicalRoot, canonicalRoot);
    for (const filePath of files) {
      try {
        await scanOneFile(filePath, sessions, messages, options);
      } catch (err) {
        console.warn(`[pi-provider] failed to scan ${filePath}: ${(err as Error).message}`);
      }
    }

    return { sessions, messages };
  }
}

interface PiSessionHeader {
  type: 'session';
  id: string;
  timestamp: string;
  cwd?: string;
  version?: number;
}

interface PiContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  // toolCall
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
}

interface PiMessageEntry {
  type: 'message';
  id: string;
  parentId: string | null;
  timestamp: string;
  message: {
    role: 'user' | 'assistant' | 'toolResult';
    content: PiContentBlock[];
    toolCallId?: string;
    toolName?: string;
    isError?: boolean;
  };
}

interface PiModelChange {
  type: 'model_change';
  id: string;
  parentId: string | null;
  timestamp: string;
  modelId?: string;
  provider?: string;
}

async function scanOneFile(
  filePath: string,
  sessions: Map<string, ScannedSession>,
  messages: RawLogMessage[],
  options: ProviderScanOptions,
): Promise<void> {
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });

  let header: PiSessionHeader | null = null;
  let currentModel: string | undefined;
  const fileMessages: RawLogMessage[] = [];

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: Record<string, unknown>;
    try { obj = JSON.parse(trimmed) as Record<string, unknown>; }
    catch { continue; }

    if (obj['type'] === 'session') {
      header = obj as unknown as PiSessionHeader;
      continue;
    }
    if (!header) continue; // malformed — no session header yet

    if (obj['type'] === 'model_change') {
      const mc = obj as unknown as PiModelChange;
      if (mc.modelId) currentModel = mc.modelId;
      continue;
    }

    if (obj['type'] === 'message') {
      const entry = obj as unknown as PiMessageEntry;
      const raw = normalisePiMessage(entry, `pi:${header.id}`, header.cwd);
      if (raw) fileMessages.push(raw);
      continue;
    }

    // Other entry types (thinking_level_change, compaction, branch_summary,
    // custom, customMessage, label, sessionInfo) are ignored.
  }

  if (!header) return;

  const startTime = header.timestamp;
  if (options.newerThan && new Date(startTime) < options.newerThan) return;

  const sessionId = `pi:${header.id}`;
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      sessionId,
      cwd: header.cwd,
      startTime,
      model: currentModel,
      provider: 'pi',
    });
  } else if (currentModel && !sessions.get(sessionId)!.model) {
    sessions.get(sessionId)!.model = currentModel;
  }

  messages.push(...fileMessages);
}

/**
 * Convert a pi `message` entry into the `RawLogMessage` shape the existing
 * classifier expects. Returns null when the entry has nothing of interest.
 */
function normalisePiMessage(
  entry: PiMessageEntry,
  namespacedSessionId: string,
  cwd: string | undefined,
): RawLogMessage | null {
  const m = entry.message;
  if (!m || !Array.isArray(m.content)) return null;

  if (m.role === 'toolResult') {
    // pi.dev's toolResult role maps to Anthropic's user-with-tool_result block.
    const text = m.content
      .filter(c => c.type === 'text' && typeof c.text === 'string')
      .map(c => c.text!)
      .join('\n');
    return {
      type: 'user',
      uuid: entry.id,
      parentUuid: entry.parentId,
      sessionId: namespacedSessionId,
      timestamp: entry.timestamp,
      cwd,
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: m.toolCallId ?? '',
            content: [{ type: 'text', text }],
          },
        ],
      },
    };
  }

  // user / assistant — map content blocks.
  const content: RawContent[] = [];
  for (const c of m.content) {
    if (c.type === 'text' && typeof c.text === 'string') {
      content.push({ type: 'text', text: c.text });
    } else if (c.type === 'thinking') {
      // Classifier already filters these — keep shape consistent.
      content.push({ type: 'thinking', thinking: c.thinking ?? '' });
    } else if (c.type === 'toolCall') {
      const rawName = c.name ?? '';
      const rawInput = c.arguments ?? {};
      const claudeName = toClaudeToolName(rawName);
      content.push({
        type: 'tool_use',
        id: c.id ?? '',
        name: claudeName,
        input: adaptToolInput(claudeName, rawInput),
      });
    }
    // unknown block types ignored
  }
  if (content.length === 0) return null;

  return {
    type: m.role === 'assistant' ? 'assistant' : 'user',
    uuid: entry.id,
    parentUuid: entry.parentId,
    sessionId: namespacedSessionId,
    timestamp: entry.timestamp,
    cwd,
    message: { role: m.role === 'assistant' ? 'assistant' : 'user', content },
  };
}

/**
 * Map pi's built-in / extension tool names to the Claude tool names that the
 * classifier recognises (`Bash`, `Edit`, `Write`, `AskUserQuestion`). Pi's
 * built-ins are lowercase (`bash`, `write`, `edit`, `ask`); extension tools
 * pass through unchanged so the classifier's SKIP_TOOLS set drops the rest.
 */
function toClaudeToolName(piName: string): string {
  const n = piName.toLowerCase();
  if (n === 'bash' || n === 'shell' || n === 'exec' || n === 'exec_command') return 'Bash';
  if (n === 'write' || n === 'write_file' || n === 'create_file') return 'Write';
  if (n === 'edit' || n === 'edit_file' || n === 'apply_patch') return 'Edit';
  if (n === 'ask' || n === 'ask_user' || n === 'askuserquestion' || n === 'ask_user_question') return 'AskUserQuestion';
  return piName;
}

/**
 * The classifier reads `Write` / `Edit` inputs as `{ file_path, content }` /
 * `{ file_path, new_string }`, but pi's `write` tool uses `path`. Adapt the
 * field names so the classifier produces the right FileOperation.
 */
function adaptToolInput(claudeName: string, piInput: Record<string, unknown>): Record<string, unknown> {
  if (claudeName === 'Write') {
    const file_path = (piInput['file_path'] as string | undefined) ?? (piInput['path'] as string | undefined) ?? '';
    const content = (piInput['content'] as string | undefined) ?? '';
    return { ...piInput, file_path, content };
  }
  if (claudeName === 'Edit') {
    const file_path = (piInput['file_path'] as string | undefined) ?? (piInput['path'] as string | undefined) ?? '';
    const new_string =
      (piInput['new_string'] as string | undefined) ??
      (piInput['content'] as string | undefined) ??
      '';
    return { ...piInput, file_path, new_string };
  }
  return piInput;
}

function collectJsonlRecursive(root: string, top: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try { entries = readdirSync(root); } catch { return out; }
  for (const e of entries) {
    const p = join(root, e);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) {
      // Skip dotted dirs at any level except top.
      if (p !== top && basename(p).startsWith('.')) continue;
      out.push(...collectJsonlRecursive(p, top));
    } else if (st.isFile() && p.endsWith('.jsonl')) {
      out.push(p);
    }
  }
  return out;
}
