import type { RawLogMessage } from './reader.js';

export type EventKind =
  | 'user_input'
  | 'file_create'
  | 'file_edit'
  | 'shell_exec'
  | 'agent_question'
  | 'agent_message'
  | 'agent_summary'
  | 'plan_accepted';

export interface ClassifiedEvent {
  kind: EventKind;
  sessionId: string;
  uuid: string;
  timestamp: string;
  text?: string;         // user_input | agent_message | agent_summary
  path?: string;         // file_create | file_edit
  content?: string;      // file_create | file_edit — full text (no longer truncated)
  command?: string;      // shell_exec
  description?: string;  // shell_exec
  question?: string;     // agent_question
  planSlug?: string;     // plan_accepted — filename slug (no extension)
  planPath?: string;     // plan_accepted — absolute path the agent passed
}

/** Tool names whose uses are never interesting enough to index. */
const SKIP_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'ToolSearch',
  'TaskOutput', 'TodoWrite',
  'NotebookEdit', 'EnterPlanMode',
  'EnterWorktree', 'CronCreate', 'CronDelete', 'CronList',
  'WebSearch', 'WebFetch', 'Skill',
  // ExitPlanMode is handled separately — it becomes a `plan_accepted` event.
]);

const TRIVIAL_BASH_FIRST_TOKENS = new Set([
  'ls', 'pwd', 'echo', 'cat', 'head', 'tail', 'which',
  'type', 'whoami', 'date', 'true', 'false', 'printf',
  'cd', 'mkdir', 'rm', 'cp', 'mv',
]);

const INTERESTING_BASH_RE = /\b(test|spec|jest|vitest|mocha|jasmine|karma|pytest|rspec|build|compile|tsc|webpack|rollup|vite|esbuild|lint|eslint|prettier|typecheck|type-check|check|deploy|publish|run\s+(?:test|build|lint|check|dev)|cargo\s+(?:test|build|check)|go\s+(?:test|build|vet)|make|cmake|bazel|buck)\b/i;

/** Return the filename without extension, e.g. `/a/b/foo.md` → `foo`. */
function basenameNoExt(p: string): string {
  const base = p.split('/').pop() ?? p;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

function isTrivialBash(command: string, description: string): boolean {
  if (INTERESTING_BASH_RE.test(command) || INTERESTING_BASH_RE.test(description)) return false;
  const parts = command.split('&&').map(p => p.trim());
  return parts.every(part => {
    const token = part.split(/\s+/)[0] ?? '';
    return TRIVIAL_BASH_FIRST_TOKENS.has(token);
  });
}

function isSystemInjection(text: string): boolean {
  if (!text) return true;
  const t = text.trim();
  if (!t) return true;
  if (t.startsWith('[Request interrupted')) return true;
  if (t === 'Tool loaded.' || t === 'Tool loaded') return true;
  if (t.startsWith('<ide_') || t.startsWith('<system-') || t.startsWith('<user-prompt-submit-hook')) return true;
  if (/^[\s\x1b\[\d;m]*$/.test(t)) return true;
  return false;
}

/** A text block is worth keeping iff it isn't a system injection and has substance. */
function isMeaningfulAgentText(text: string): boolean {
  if (isSystemInjection(text)) return false;
  return text.trim().length > 0;
}

/**
 * Classify a deduplicated list of raw log messages into structured events.
 *
 * Modern LLM providers no longer expose chain-of-thought, so we no longer
 * track `thinking` blocks. Plain assistant `text` blocks split into two
 * categories based on what *just happened* in the conversation:
 *
 *   - the same turn contains tool_use blocks → `agent_message`
 *     (mid-work narration, "I'll edit foo.ts next")
 *   - the previous message in the log is a user `tool_result` → `agent_summary`
 *     (the agent got tool output back and is now wrapping up / reporting)
 *   - otherwise → `agent_message`
 *     (acknowledgment of a user text turn before any work starts)
 *
 * Recall over precision:
 * - KEEP user text                            → UserInput
 * - KEEP assistant text after tool_result     → AgentSummary
 * - KEEP other assistant text                 → AgentMessage
 * - KEEP Write tool uses                      → FileOperation create
 * - KEEP Edit tool uses                       → FileOperation edit
 * - KEEP non-trivial Bash                     → ShellExecution
 * - KEEP AskUserQuestion                      → AgentQuestion
 * - SKIP thinking, reads, searches, internal tooling
 */
export function classifyMessages(messages: RawLogMessage[]): ClassifiedEvent[] {
  const events: ClassifiedEvent[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    const { type, uuid, sessionId, timestamp } = msg;
    const content = msg.message?.content ?? [];

    if (type === 'user') {
      for (const item of content) {
        if (item.type !== 'text') continue;
        if (isSystemInjection(item.text)) continue;
        events.push({ kind: 'user_input', sessionId, uuid, timestamp, text: item.text.trim() });
      }
      continue;
    }

    if (type !== 'assistant') continue;

    const hasAnyToolUse = content.some(c => c.type === 'tool_use');
    const hasQuestion = content.some(
      c => c.type === 'tool_use' && (c as { name?: string }).name === 'AskUserQuestion',
    );

    // Did the most recent prior message in the same session contain a
    // tool_result? If so, this assistant turn is a "wrap-up after work"
    // (AgentSummary). We walk backwards skipping unrelated sessions just in
    // case the input was interleaved.
    const followsToolResult = (() => {
      for (let j = i - 1; j >= 0; j--) {
        const prev = messages[j]!;
        if (prev.sessionId !== sessionId) continue;
        if (prev.type === 'user') {
          const prevContent = prev.message?.content;
          if (!Array.isArray(prevContent)) return false;
          return prevContent.some(c => c && typeof c === 'object' && (c as { type?: string }).type === 'tool_result');
        }
        return false; // an assistant message in between blocks the signal
      }
      return false;
    })();

    for (const item of content) {
      if (item.type === 'thinking') continue;

      if (item.type === 'text') {
        if (hasQuestion) continue;        // AgentQuestion carries the payload
        const text = item.text;
        if (!isMeaningfulAgentText(text)) continue;
        const kind: EventKind =
          hasAnyToolUse ? 'agent_message'
          : followsToolResult ? 'agent_summary'
          : 'agent_message';
        events.push({ kind, sessionId, uuid, timestamp, text: text.trim() });
        continue;
      }

      if (item.type !== 'tool_use') continue;

      const { name, input } = item as { type: 'tool_use'; name: string; input: Record<string, unknown> };
      if (SKIP_TOOLS.has(name)) continue;

      if (name === 'Write') {
        const path = (input.file_path as string | undefined) ?? '';
        const rawContent = (input.content as string | undefined) ?? '';
        // Full content (not truncated) — the LSP reverse pass uses it for
        // name-match enrichment, and Symbol storage doesn't embed it so the
        // cost is purely the row's TEXT bytes.
        events.push({ kind: 'file_create', sessionId, uuid, timestamp, path, content: rawContent });
      } else if (name === 'Edit') {
        const path = (input.file_path as string | undefined) ?? '';
        const newStr = (input.new_string as string | undefined) ?? '';
        events.push({ kind: 'file_edit', sessionId, uuid, timestamp, path, content: newStr });
      } else if (name === 'Bash') {
        const command = (input.command as string | undefined) ?? '';
        const description = (input.description as string | undefined) ?? '';
        if (isTrivialBash(command, description)) continue;
        events.push({ kind: 'shell_exec', sessionId, uuid, timestamp, command, description });
      } else if (name === 'AskUserQuestion') {
        const question = (input.question as string | undefined) ?? '';
        if (!question.trim()) continue;
        events.push({ kind: 'agent_question', sessionId, uuid, timestamp, question });
      } else if (name === 'ExitPlanMode') {
        // Claude Plan Mode tool — the agent presents a plan and the user
        // accepts/rejects. The `input` carries the full plan markdown and
        // the path it was saved to. We turn this into a `plan_accepted`
        // event so the plans indexer can link the Plan node back to the
        // session and the LSP reverse pass can scope plan symbol-links to
        // the session's actual edits.
        const planPath = (input.planFilePath as string | undefined) ?? '';
        if (!planPath) continue;
        const planSlug = basenameNoExt(planPath);
        if (!planSlug) continue;
        events.push({ kind: 'plan_accepted', sessionId, uuid, timestamp, planSlug, planPath });
      }
      // All other tool names (Agent, custom MCP tools, etc.) are skipped.
    }
  }

  return events;
}

/** Extract all unique sessionIds from a message list. */
export function extractSessions(messages: RawLogMessage[]): Map<string, { cwd?: string; startTime: string; model?: string }> {
  const sessions = new Map<string, { cwd?: string; startTime: string; model?: string }>();
  for (const msg of messages) {
    if (!sessions.has(msg.sessionId)) {
      sessions.set(msg.sessionId, {
        cwd: msg.cwd,
        startTime: msg.timestamp,
        model: msg.message?.model,
      });
    } else if (msg.type === 'assistant' && msg.message?.model) {
      const existing = sessions.get(msg.sessionId)!;
      if (!existing.model) existing.model = msg.message.model;
    }
  }
  return sessions;
}
