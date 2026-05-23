/**
 * Codex CLI provider — reads OpenAI Codex sessions from `~/.codex/`.
 *
 * Codex stores session metadata in a SQLite database (`state_5.sqlite`), with
 * each row in the `threads` table pointing at a `rollout_path` — the actual
 * line-delimited JSON transcript. Each line is one of:
 *
 *   { "type": "session_meta",  "timestamp", "payload": {id, cwd, ...} }      first line
 *   { "type": "turn_context",  "timestamp", "payload": {...} }               skipped
 *   { "type": "event_msg",     "timestamp", "payload": {type, ...} }         skipped — duplicates response_items
 *   { "type": "response_item", "timestamp", "payload": {type, ...} }         the actual events
 *
 * The `response_item.payload.type` values we map:
 *
 *   message                    role ∈ user|assistant|developer
 *                              content: [{type: 'input_text'|'output_text', text}]
 *                              → UserInput / AgentMessage (developer dropped)
 *   function_call              {name, arguments(JSON-string), call_id}
 *                              → assistant turn with tool_use
 *   function_call_output       {call_id, output(string)}
 *                              → user turn with tool_result
 *   custom_tool_call           {name: 'apply_patch', input(string), call_id}
 *                              → assistant turn with tool_use (Write/Edit)
 *   custom_tool_call_output    {call_id, output(string)}
 *                              → user turn with tool_result
 *
 * Tool-name normalisation: Codex names like `exec_command` and `apply_patch`
 * map to Claude tool names (`Bash`, `Write`, `Edit`) so the existing classifier
 * sees them as the same operations and produces the right node types.
 */

import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import Database from 'better-sqlite3';
import type { RawContent, RawLogMessage } from '../reader.js';
import type {
  AgentLogProvider,
  ProviderScanOptions,
  ProviderScanResult,
  ScannedSession,
} from '../provider.js';

export interface CodexProviderOptions {
  /** Absolute path to Codex's state sqlite. Defaults to `~/.codex/state_5.sqlite`. */
  statePath: string;
}

interface ThreadRow {
  id: string;
  rollout_path: string;
  /** Epoch seconds (older column). */
  created_at: number;
  updated_at: number;
  /** Epoch milliseconds (newer column, added in a Codex migration). */
  created_at_ms: number | null;
  updated_at_ms: number | null;
  cwd: string;
  title: string;
  model_provider: string;
  model: string | null;
  archived: number;
  first_user_message: string;
}

export class CodexProvider implements AgentLogProvider {
  readonly name = 'codex' as const;

  constructor(private readonly opts: CodexProviderOptions) {}

  async scan(options: ProviderScanOptions): Promise<ProviderScanResult> {
    const sessions = new Map<string, ScannedSession>();
    const messages: RawLogMessage[] = [];

    if (!existsSync(this.opts.statePath)) {
      return { sessions, messages };
    }

    const db = new Database(this.opts.statePath, { readonly: true, fileMustExist: true });
    try {
      const rows = db
        .prepare(
          `SELECT id, rollout_path, created_at, updated_at, created_at_ms, updated_at_ms,
                  cwd, title, model_provider, model, archived, first_user_message
           FROM threads
           WHERE archived = 0
           ORDER BY updated_at DESC`,
        )
        .all() as ThreadRow[];

      for (const row of rows) {
        // `created_at` is epoch SECONDS in older rows; `created_at_ms` is
        // epoch ms in newer rows. Prefer ms when present.
        const createdMs = typeof row.created_at_ms === 'number' && row.created_at_ms > 0
          ? row.created_at_ms
          : row.created_at * 1000;
        const startTime = new Date(createdMs).toISOString();
        if (options.newerThan && new Date(startTime) < options.newerThan) continue;

        const sessionId = `codex:${row.id}`;
        if (!sessions.has(sessionId)) {
          sessions.set(sessionId, {
            sessionId,
            cwd: row.cwd,
            startTime,
            model: row.model ?? row.model_provider ?? undefined,
            provider: 'codex',
          });
        }

        if (!row.rollout_path || !existsSync(row.rollout_path)) continue;
        try {
          const fileMsgs = await readCodexRollout(row.rollout_path, sessionId, row.cwd);
          messages.push(...fileMsgs);
        } catch (err) {
          console.warn(`[codex-provider] failed to parse rollout ${row.rollout_path}: ${(err as Error).message}`);
        }
      }
    } finally {
      db.close();
    }

    return { sessions, messages };
  }
}

interface ResponseItemRecord {
  type: 'response_item';
  timestamp: string;
  payload: Record<string, unknown>;
}

/**
 * Parse a Codex rollout JSONL file into RawLogMessage[].
 *
 * `event_msg` records duplicate the conversational substance of
 * `response_item.message` / `function_call*` (Codex emits both for different
 * consumers). To avoid double-counting we ingest only `response_item` records.
 */
async function readCodexRollout(
  rolloutPath: string,
  sessionId: string,
  cwd: string,
): Promise<RawLogMessage[]> {
  const rl = createInterface({
    input: createReadStream(rolloutPath, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });

  const out: RawLogMessage[] = [];
  let lineNum = 0;

  for await (const line of rl) {
    lineNum++;
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: Record<string, unknown>;
    try { obj = JSON.parse(trimmed) as Record<string, unknown>; }
    catch { continue; }
    if (obj['type'] !== 'response_item') continue;

    const rec = obj as unknown as ResponseItemRecord;
    const payload = rec.payload;
    const ptype = payload['type'];
    const timestamp = rec.timestamp ?? new Date().toISOString();

    // Synthetic id when none is present (the classifier dedups by uuid).
    const recId = (payload['id'] as string | undefined)
      ?? (payload['call_id'] as string | undefined)
      ?? `codex:${sessionId}:line:${lineNum}`;

    if (ptype === 'message') {
      const role = payload['role'] as string | undefined;
      if (role === 'developer') continue;  // base/system instructions — not a turn
      if (role !== 'user' && role !== 'assistant') continue;

      const rawContent = payload['content'];
      if (!Array.isArray(rawContent)) continue;

      const content: RawContent[] = [];
      for (const c of rawContent) {
        if (!c || typeof c !== 'object') continue;
        const block = c as Record<string, unknown>;
        const btype = block['type'];
        const text = block['text'];
        if (typeof text !== 'string' || text.length === 0) continue;
        if (btype !== 'input_text' && btype !== 'output_text' && btype !== 'text') continue;
        if (isCodexEnvelope(text)) continue;
        content.push({ type: 'text', text });
      }
      if (content.length === 0) continue;

      out.push({
        type: role,
        uuid: recId,
        parentUuid: null,
        sessionId,
        timestamp,
        cwd,
        message: { role, content },
      });
      continue;
    }

    if (ptype === 'function_call') {
      const name = (payload['name'] as string | undefined) ?? '';
      if (!name) continue;
      let input: Record<string, unknown> = {};
      const args = payload['arguments'];
      if (typeof args === 'string') {
        try { input = JSON.parse(args) as Record<string, unknown>; }
        catch { input = { _raw: args }; }
      } else if (args && typeof args === 'object') {
        input = args as Record<string, unknown>;
      }
      const callId = (payload['call_id'] as string | undefined) ?? recId;
      const claudeName = toClaudeToolName(name);
      const claudeInput = adaptToolInput(claudeName, input);

      out.push({
        type: 'assistant',
        uuid: recId,
        parentUuid: null,
        sessionId,
        timestamp,
        cwd,
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: callId, name: claudeName, input: claudeInput }],
        },
      });
      continue;
    }

    if (ptype === 'function_call_output' || ptype === 'custom_tool_call_output') {
      const callId = payload['call_id'] as string | undefined;
      const output = payload['output'];
      const text = typeof output === 'string' ? output : JSON.stringify(output ?? '');
      out.push({
        type: 'user',
        uuid: recId,
        parentUuid: null,
        sessionId,
        timestamp,
        cwd,
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: callId ?? '', content: [{ type: 'text', text }] }],
        },
      });
      continue;
    }

    if (ptype === 'custom_tool_call') {
      const name = (payload['name'] as string | undefined) ?? '';
      const inputStr = payload['input'];
      const callId = (payload['call_id'] as string | undefined) ?? recId;
      if (!name) continue;
      const { toolName, parsed } = adaptCustomTool(name, typeof inputStr === 'string' ? inputStr : '');
      out.push({
        type: 'assistant',
        uuid: recId,
        parentUuid: null,
        sessionId,
        timestamp,
        cwd,
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: callId, name: toolName, input: parsed }],
        },
      });
      continue;
    }

    // Other response_item payload types ignored (reasoning_summary, etc.).
  }

  return out;
}

/** True when the text is one of Codex's auto-injected envelope blocks. */
function isCodexEnvelope(text: string): boolean {
  const t = text.trim();
  return (
    t.startsWith('<environment_context>') ||
    t.startsWith('<permissions') ||
    t.startsWith('<collaboration_mode>') ||
    t.startsWith('<skills_instructions>')
  );
}

/**
 * Map Codex's function-call name to the Claude-equivalent tool name the
 * classifier recognises (`Edit`, `Write`, `Bash`, `AskUserQuestion`). Names
 * Codex actually emits in practice: `exec_command`, `apply_patch`, `shell`.
 */
function toClaudeToolName(codexName: string): string {
  const n = codexName.toLowerCase();
  if (n === 'shell' || n === 'bash' || n === 'exec' || n === 'exec_command' || n === 'execute_command') return 'Bash';
  if (n === 'apply_patch' || n === 'edit_file' || n === 'edit') return 'Edit';
  if (n === 'write_file' || n === 'create_file' || n === 'write') return 'Write';
  if (n === 'ask_user' || n === 'askuserquestion' || n === 'ask_user_question') return 'AskUserQuestion';
  return codexName;
}

/**
 * The classifier reads `Bash` inputs as `{ command, description }` and
 * `Edit`/`Write` as `{ file_path, content / new_string }`. Codex's
 * `exec_command` arguments are `{ cmd, workdir, ... }` — adapt the field
 * names so the classifier produces the right ShellExecution / FileOperation.
 */
function adaptToolInput(claudeName: string, codexInput: Record<string, unknown>): Record<string, unknown> {
  if (claudeName === 'Bash') {
    const command =
      (codexInput['command'] as string | undefined) ??
      (codexInput['cmd'] as string | undefined) ??
      '';
    const description =
      (codexInput['description'] as string | undefined) ??
      (codexInput['justification'] as string | undefined) ??
      '';
    return { ...codexInput, command, description };
  }
  return codexInput;
}

/**
 * Custom-tool calls (currently just `apply_patch`) carry a string `input`
 * rather than a JSON-encoded args object. We crack the patch header to
 * decide whether it's a Write (new file) or an Edit (in-place change), and
 * normalise the payload to the classifier's `Write` / `Edit` schema.
 */
function adaptCustomTool(name: string, input: string): { toolName: string; parsed: Record<string, unknown> } {
  const lower = name.toLowerCase();
  if (lower !== 'apply_patch') {
    return { toolName: toClaudeToolName(name), parsed: { _raw: input } };
  }
  const addMatch = input.match(/^\*\*\* Add File: (.+)$/m);
  const updateMatch = input.match(/^\*\*\* Update File: (.+)$/m);
  if (addMatch) {
    const filePath = addMatch[1]!.trim();
    // Extract the additions to use as a preview.
    const content = input
      .split('\n')
      .filter(l => l.startsWith('+') && !l.startsWith('+++'))
      .map(l => l.slice(1))
      .join('\n');
    return { toolName: 'Write', parsed: { file_path: filePath, content } };
  }
  if (updateMatch) {
    const filePath = updateMatch[1]!.trim();
    const newStr = input
      .split('\n')
      .filter(l => l.startsWith('+') && !l.startsWith('+++'))
      .map(l => l.slice(1))
      .join('\n');
    return { toolName: 'Edit', parsed: { file_path: filePath, new_string: newStr } };
  }
  // Unknown patch shape — keep the raw text so it lands as a ShellExecution-like blob.
  return { toolName: 'Edit', parsed: { file_path: '', new_string: input } };
}
