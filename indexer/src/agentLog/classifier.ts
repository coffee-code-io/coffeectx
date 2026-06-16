import type { RawLogMessage } from './reader.js';

export type EventKind =
  | 'user_input'
  | 'file_create'
  | 'file_edit'
  | 'shell_exec'
  | 'agent_question'
  | 'agent_message'
  | 'plan_accepted'
  | 'plan_proposed'
  | 'todo_write';

export interface ClassifiedEvent {
  kind: EventKind;
  sessionId: string;
  uuid: string;
  timestamp: string;
  text?: string;         // user_input | agent_message | plan_proposed (body)
  path?: string;         // file_create | file_edit
  content?: string;      // file_create | file_edit
  command?: string;      // shell_exec
  description?: string;  // shell_exec
  question?: string;     // agent_question
  planSlug?: string;     // plan_accepted — filename slug (no extension)
  planPath?: string;     // plan_accepted — absolute path the agent passed
  /** True iff this `agent_message` event was emitted in a turn that
   *  followed a `tool_result`. Carried for the span detector's benefit;
   *  no DB persistence. */
  postToolResult?: boolean;
  /** Parsed todo list at the moment of a `todo_write` event. Each entry
   *  carries the `content` text and `status` (pending|in_progress|completed).
   *  Used by the span detector; never persisted as a node. */
  todos?: Array<{ content: string; status: string }>;
}

/** Tool names whose uses are never interesting enough to index. */
const SKIP_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'ToolSearch',
  'TaskOutput',
  'NotebookEdit', 'EnterPlanMode',
  'EnterWorktree', 'CronCreate', 'CronDelete', 'CronList',
  'WebSearch', 'WebFetch', 'Skill',
  // ExitPlanMode → plan_accepted; TodoWrite → todo_write. Handled below.
]);

const TRIVIAL_BASH_FIRST_TOKENS = new Set([
  'ls', 'pwd', 'echo', 'cat', 'head', 'tail', 'which',
  'type', 'whoami', 'date', 'true', 'false', 'printf',
  'cd', 'mkdir', 'rm', 'cp', 'mv',
]);

const INTERESTING_BASH_RE = /\b(test|spec|jest|vitest|mocha|jasmine|karma|pytest|rspec|build|compile|tsc|webpack|rollup|vite|esbuild|lint|eslint|prettier|typecheck|type-check|check|deploy|publish|run\s+(?:test|build|lint|check|dev)|cargo\s+(?:test|build|check)|go\s+(?:test|build|vet)|make|cmake|bazel|buck)\b/i;

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

function isMeaningfulAgentText(text: string): boolean {
  if (isSystemInjection(text)) return false;
  return text.trim().length > 0;
}

/**
 * Pull every `<proposed_plan>...</proposed_plan>` body out of an agent's
 * message text. Codex uses this tag to surface a plan that the assistant
 * wants the user to accept before execution. Returns the inner text of each
 * match, trimmed; an empty array when no tag is present.
 */
const PROPOSED_PLAN_RE = /<proposed_plan>([\s\S]*?)<\/proposed_plan>/g;
function extractProposedPlans(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(PROPOSED_PLAN_RE)) {
    const body = m[1]!.trim();
    if (body.length > 0) out.push(body);
  }
  return out;
}

/**
 * Classify a deduplicated list of raw log messages into structured events.
 *
 * Recall over precision — see SKIP_TOOLS for what's filtered. Assistant text
 * blocks all become `agent_message`; the span detector decides where summary
 * boundaries actually fall and which AgentMessage carries `isSummary="true"`.
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

    const hasQuestion = content.some(
      c => c.type === 'tool_use' && (c as { name?: string }).name === 'AskUserQuestion',
    );

    // Did the most recent prior message in this session contain a tool_result?
    // Used as the `postToolResult` hint for span signals.
    const followsToolResult = (() => {
      for (let j = i - 1; j >= 0; j--) {
        const prev = messages[j]!;
        if (prev.sessionId !== sessionId) continue;
        if (prev.type === 'user') {
          const prevContent = prev.message?.content;
          if (!Array.isArray(prevContent)) return false;
          return prevContent.some(c => c && typeof c === 'object' && (c as { type?: string }).type === 'tool_result');
        }
        return false;
      }
      return false;
    })();

    for (const item of content) {
      if (item.type === 'thinking') continue;

      if (item.type === 'text') {
        if (hasQuestion) continue;
        const text = item.text;
        if (!isMeaningfulAgentText(text)) continue;

        // Codex agents emit plans inline, wrapped in <proposed_plan>...
        // </proposed_plan> tags. Each pair becomes a `plan_proposed` event;
        // indexLogs mints a Plan node from the body. The agent_message
        // event still fires for the rest of the text (or the whole text
        // when no tag is present) so the existing summary/seek logic
        // doesn't lose the narrative.
        const plans = extractProposedPlans(text);
        for (const planText of plans) {
          events.push({
            kind: 'plan_proposed',
            sessionId, uuid, timestamp,
            text: planText,
          });
        }

        events.push({
          kind: 'agent_message',
          sessionId, uuid, timestamp,
          text: text.trim(),
          postToolResult: followsToolResult,
        });
        continue;
      }

      if (item.type !== 'tool_use') continue;

      const { name, input } = item as { type: 'tool_use'; name: string; input: Record<string, unknown> };

      if (name === 'TodoWrite') {
        const todos = (input.todos as Array<{ content?: string; status?: string }> | undefined) ?? [];
        events.push({
          kind: 'todo_write',
          sessionId, uuid, timestamp,
          todos: todos
            .filter(t => typeof t?.content === 'string')
            .map(t => ({ content: String(t.content ?? ''), status: String(t.status ?? '') })),
        });
        continue;
      }

      if (SKIP_TOOLS.has(name)) continue;

      if (name === 'Write') {
        const path = (input.file_path as string | undefined) ?? '';
        const rawContent = (input.content as string | undefined) ?? '';
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
        const planPath = (input.planFilePath as string | undefined) ?? '';
        if (!planPath) continue;
        const planSlug = basenameNoExt(planPath);
        if (!planSlug) continue;
        events.push({ kind: 'plan_accepted', sessionId, uuid, timestamp, planSlug, planPath });
      }
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
