import type { RawLogMessage } from './reader.js';

export type EventKind = 'user_input' | 'file_create' | 'file_edit' | 'shell_exec' | 'agent_question' | 'agent_thought';

export interface ClassifiedEvent {
  kind: EventKind;
  sessionId: string;
  uuid: string;
  timestamp: string;
  // populated per kind:
  text?: string;        // user_input | agent_thought
  path?: string;        // file_create | file_edit
  preview?: string;     // file_create | file_edit
  command?: string;     // shell_exec
  description?: string; // shell_exec
  question?: string;    // agent_question
  linkedTo?: string;    // agent_thought: UUID of the event this thought immediately preceded
}

/** Tool names whose uses are never interesting enough to index. */
const SKIP_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'ToolSearch',
  'TaskOutput', 'TodoWrite',
  'NotebookEdit', 'EnterPlanMode', 'ExitPlanMode',
  'EnterWorktree', 'CronCreate', 'CronDelete', 'CronList',
  'WebSearch', 'WebFetch', 'Skill',
]);

/**
 * Bash commands whose first token is on this list are trivially uninteresting
 * (directory listing, echoes, simple checks) and get skipped — unless they are
 * chained with a non-trivial command.
 */
const TRIVIAL_BASH_FIRST_TOKENS = new Set([
  'ls', 'pwd', 'echo', 'cat', 'head', 'tail', 'which',
  'type', 'whoami', 'date', 'true', 'false', 'printf',
  'cd', 'mkdir', 'rm', 'cp', 'mv',
]);

/**
 * Keywords that make a command interesting regardless of its first token.
 * Matches test runners, build tools, linters, CI steps, etc.
 */
const INTERESTING_BASH_RE = /\b(test|spec|jest|vitest|mocha|jasmine|karma|pytest|rspec|build|compile|tsc|webpack|rollup|vite|esbuild|lint|eslint|prettier|typecheck|type-check|check|deploy|publish|run\s+(?:test|build|lint|check|dev)|cargo\s+(?:test|build|check)|go\s+(?:test|build|vet)|make|cmake|bazel|buck)\b/i;

function isTrivialBash(command: string, description: string): boolean {
  // A command is interesting if it contains known interesting keywords
  if (INTERESTING_BASH_RE.test(command) || INTERESTING_BASH_RE.test(description)) return false;

  // For compound commands (&&-chained), only trivial if ALL parts are trivial
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
  // Claude CLI system-injected messages
  if (t.startsWith('[Request interrupted')) return true;
  if (t === 'Tool loaded.' || t === 'Tool loaded') return true;
  // IDE / system reminder tags
  if (t.startsWith('<ide_') || t.startsWith('<system-') || t.startsWith('<user-prompt-submit-hook')) return true;
  // ANSI-only or whitespace-only
  if (/^[\s\x1b\[\d;m]*$/.test(t)) return true;
  return false;
}

/**
 * Classify a deduplicated list of raw log messages into structured events.
 *
 * Heuristic — recall over precision:
 * - KEEP  user text messages (UserInput)
 * - KEEP  Write tool uses   (FileOperation create)
 * - KEEP  Edit tool uses    (FileOperation edit)
 * - KEEP  non-trivial Bash  (ShellExecution)
 * - KEEP  AskUserQuestion   (AgentQuestion)
 * - KEEP  thinking blocks   (AgentThought, emitted before the event they preceded)
 * - SKIP  reads, searches, internal tooling
 *
 * Thinking blocks that immediately precede a tool_use are emitted as separate
 * AgentThought events (with linkedTo pointing to the subsequent event's uuid)
 * rather than being attached as a field of the following event.
 */
export function classifyMessages(messages: RawLogMessage[]): ClassifiedEvent[] {
  const events: ClassifiedEvent[] = [];
  // lastThought carries accumulated thinking blocks across consecutive assistant messages.
  let lastThought: { text: string; uuid: string } | undefined;

  for (const msg of messages) {
    const { type, uuid, sessionId, timestamp } = msg;
    const content = msg.message?.content ?? [];

    if (type === 'user') {
      // A user turn breaks any pending thought accumulation.
      lastThought = undefined;
      for (const item of content) {
        if (item.type !== 'text') continue;
        if (isSystemInjection(item.text)) continue;
        events.push({ kind: 'user_input', sessionId, uuid, timestamp, text: item.text.trim() });
      }
    } else if (type === 'assistant') {
      for (const item of content) {
        if (item.type === 'thinking') {
          // Capture the most recent thinking block; multiple are concatenated.
          const text = item.thinking?.trim();
          if (text) {
            if (lastThought) {
              lastThought = { text: `${lastThought.text}\n\n${text}`, uuid: lastThought.uuid };
            } else {
              lastThought = { text, uuid };
            }
          }
          continue;
        }

        if (item.type !== 'tool_use') {
          // Non-thinking, non-tool items (e.g. text) reset the thought accumulator.
          lastThought = undefined;
          continue;
        }

        const { name, input } = item as { type: 'tool_use'; name: string; input: Record<string, unknown> };

        if (SKIP_TOOLS.has(name)) {
          lastThought = undefined;
          continue;
        }

        // Snapshot and clear the thought before deciding whether to keep this event.
        const thought = lastThought;
        lastThought = undefined;

        if (name === 'Write') {
          const path = (input.file_path as string | undefined) ?? '';
          const rawContent = (input.content as string | undefined) ?? '';
          if (thought) {
            events.push({ kind: 'agent_thought', sessionId, uuid: thought.uuid, timestamp, text: thought.text, linkedTo: uuid });
          }
          events.push({ kind: 'file_create', sessionId, uuid, timestamp, path, preview: rawContent.slice(0, 300) });

        } else if (name === 'Edit') {
          const path = (input.file_path as string | undefined) ?? '';
          const newStr = (input.new_string as string | undefined) ?? '';
          if (thought) {
            events.push({ kind: 'agent_thought', sessionId, uuid: thought.uuid, timestamp, text: thought.text, linkedTo: uuid });
          }
          events.push({ kind: 'file_edit', sessionId, uuid, timestamp, path, preview: newStr.slice(0, 300) });

        } else if (name === 'Bash') {
          const command = (input.command as string | undefined) ?? '';
          const description = (input.description as string | undefined) ?? '';
          if (isTrivialBash(command, description)) continue;
          if (thought) {
            events.push({ kind: 'agent_thought', sessionId, uuid: thought.uuid, timestamp, text: thought.text, linkedTo: uuid });
          }
          events.push({ kind: 'shell_exec', sessionId, uuid, timestamp, command, description });

        } else if (name === 'AskUserQuestion') {
          const question = (input.question as string | undefined) ?? '';
          if (!question.trim()) continue;
          if (thought) {
            events.push({ kind: 'agent_thought', sessionId, uuid: thought.uuid, timestamp, text: thought.text, linkedTo: uuid });
          }
          events.push({ kind: 'agent_question', sessionId, uuid, timestamp, question });
        }
        // All other tool names (Agent, custom MCP tools, etc.) are skipped.
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
