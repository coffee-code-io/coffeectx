/**
 * Right-sidebar chat with the pi-coding-agent.
 *
 * Wiring:
 *  - On project change we open an EventSource against `/api/p/:p/agent/stream`.
 *    The server fans out pi events + a `navigate` envelope from the
 *    `navigate_to_node` tool.
 *  - User submits a message → POST `/api/p/:p/agent/message`. The reply just
 *    confirms queueing; everything the user sees comes back over SSE.
 *  - "New chat" → POST `/api/p/:p/agent/new` then the stream auto-reconnects.
 *
 * Citations: the agent embeds `^<uuid>` markers inline in its prose. We
 * split assistant text on those markers and render each match as a
 * clickable chip that resolves typeName lazily via /nodes/:id and calls
 * `setSelected(uuid)` on click. The server doesn't track references at all
 * — explicit-cite-only avoids the noise of tool-result UUID scraping.
 *
 * Rendering rules (kept lightweight on purpose):
 *  - `message_end` events with assistant text → an "agent" bubble.
 *  - `tool_execution_start` events → a small inline "→ tool(args)" chip.
 *  - `tool_execution_end` with `isError:true` → red error chip.
 *  - `agent_end` → idle indicator off.
 *  - `navigate` envelope → call `setSelected(nodeId)`.
 */

import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, type UiAgentSessionInfo } from '../api/client';
import { useUi } from '../state/store';

// ── Stream envelope shape (mirrors server: AgentEnvelope) ──────────────────

type AgentEnvelope =
  | { kind: 'ready'; activeSessionPath?: string; history: HistoryItem[] }
  | { kind: 'error'; message: string }
  | { kind: 'session_switched'; activeSessionPath?: string; history: HistoryItem[] }
  | { kind: 'navigate'; nodeId: string; reason?: string }
  | { kind: 'agent'; event: PiEvent };

type HistoryItem =
  | { role: 'user'; text: string }
  | { role: 'agent'; text: string }
  | { role: 'tool'; toolName: string; text: string; toolError?: boolean };

type PiEvent =
  | { type: 'agent_start' }
  | { type: 'agent_end'; willRetry?: boolean }
  | { type: 'turn_start' }
  | { type: 'turn_end' }
  | { type: 'message_start' }
  | { type: 'message_update'; message?: { content?: Array<{ type?: string; text?: string }> } }
  | { type: 'message_end'; message?: { role?: string; content?: Array<{ type?: string; text?: string }> } }
  | { type: 'tool_execution_start'; toolCallId: string; toolName: string; args: unknown }
  | { type: 'tool_execution_end'; toolCallId: string; toolName: string; isError?: boolean }
  | { type: 'error'; message: string }
  | { type: string; [k: string]: unknown };

// ── UI message model (what we actually render) ─────────────────────────────

interface ChatItem {
  /** Stable key for React. */
  key: string;
  role: 'user' | 'agent' | 'tool' | 'system';
  text: string;
  /** For tool items: the tool name. */
  toolName?: string;
  /** For tool items: whether the result was an error. */
  toolError?: boolean;
}

// ──────────────────────────────────────────────────────────────────────────

export function AgentChatPanel() {
  const project = useUi(s => s.project);
  const setSelected = useUi(s => s.setSelected);
  const rememberAgentSession = useUi(s => s.rememberAgentSession);
  const queryClient = useQueryClient();
  const [items, setItems] = useState<ChatItem[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [connError, setConnError] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [activeSessionPath, setActiveSessionPath] = useState<string | undefined>(undefined);
  const [showSessions, setShowSessions] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Remembers the activeSessionPath we last painted history for. The SSE
  // stream re-fires `ready` on every transport reconnect (idle hiccups,
  // proxy timeouts, browser tab throttling on switch), and the history
  // payload only carries user/assistant text — not tool calls. Without
  // this guard each reconnect would wipe accumulated tool-execution
  // entries from `items`. We only repaint when the active path actually
  // changes (initial connect or a real session switch).
  const paintedHistoryFor = useRef<string | undefined>(undefined);
  // Session list — refetched when the active session changes so the
  // dropdown reflects newly-created sessions immediately.
  const sessionList = useQuery({
    queryKey: ['agent-sessions', project, activeSessionPath],
    queryFn: () => (project ? api.listAgentSessions(project) : Promise.resolve({ sessions: [] })),
    enabled: !!project,
    staleTime: 5_000,
  });

  // ── SSE connection lifecycle ────────────────────────────────────────────
  useEffect(() => {
    if (!project) return;
    setItems([]);
    setConnError(null);
    setAuthError(null);
    // New project = next `ready` should repaint, even if paths happen to
    // overlap (unlikely but cheap to guard).
    paintedHistoryFor.current = undefined;

    const es = new EventSource(api.agentStreamUrl(project));
    es.onmessage = (ev) => {
      try {
        const env = JSON.parse(ev.data) as AgentEnvelope;
        handleEnvelope(env);
      } catch { /* malformed line — ignore */ }
    };
    es.onerror = () => {
      // EventSource auto-reconnects; surface a transient warning only after
      // the connection has been down long enough to matter.
      setConnError('connection interrupted; retrying…');
    };

    function handleEnvelope(env: AgentEnvelope) {
      switch (env.kind) {
        case 'ready':
          setConnError(null);
          setActiveSessionPath(env.activeSessionPath);
          // Paint the resumed session's history immediately on the
          // initial connect / real session change. Skip it on plain
          // transport reconnects — `ready` re-fires every time the SSE
          // re-handshakes, but the history only carries user/assistant
          // text (no tool calls), so replaying it would wipe locally-
          // accumulated tool-execution entries.
          if (paintedHistoryFor.current !== env.activeSessionPath) {
            paintedHistoryFor.current = env.activeSessionPath;
            setItems(env.history.map((h, i) => historyToChatItem(h, i)));
          }
          if (project) rememberAgentSession(project, env.activeSessionPath);
          return;
        case 'error':
          setAuthError(env.message);
          return;
        case 'session_switched':
          // Replace local scrollback with the rendered history of the
          // newly-active session. The server reattached our listener to
          // the new session, so subsequent agent events flow into the same
          // EventSource.
          setActiveSessionPath(env.activeSessionPath);
          paintedHistoryFor.current = env.activeSessionPath;
          if (project) rememberAgentSession(project, env.activeSessionPath);
          setItems(env.history.map((h, i) => historyToChatItem(h, i)));
          setBusy(false);
          // Refresh the session list so the new active flag is reflected.
          queryClient.invalidateQueries({ queryKey: ['agent-sessions', project] });
          return;
        case 'navigate':
          setSelected(env.nodeId);
          return;
        case 'agent':
          ingestPiEvent(env.event);
          return;
      }
    }

    function ingestPiEvent(pe: PiEvent) {
      switch (pe.type) {
        case 'agent_start':
          setBusy(true);
          return;
        case 'agent_end':
          setBusy(false);
          // Refresh the session list so the message count + active flag
          // for the freshly-prompted session reflect the new turn. The
          // query key is keyed on `activeSessionPath`, which doesn't
          // change when you prompt the same session — so without this
          // invalidation the popover would only update on session
          // switches.
          if (project) {
            queryClient.invalidateQueries({ queryKey: ['agent-sessions', project] });
          }
          return;
        case 'tool_execution_start': {
          const tool = pe as Extract<PiEvent, { type: 'tool_execution_start' }>;
          const desc = describeToolCall(tool.toolName, tool.args);
          setItems(prev => [...prev, {
            key: `tool:${tool.toolCallId}`,
            role: 'tool',
            toolName: tool.toolName,
            text: desc,
          }]);
          return;
        }
        case 'tool_execution_end': {
          const t = pe as Extract<PiEvent, { type: 'tool_execution_end' }>;
          if (t.isError) {
            setItems(prev => prev.map(it =>
              it.key === `tool:${t.toolCallId}` ? { ...it, toolError: true } : it,
            ));
          }
          return;
        }
        case 'message_end': {
          const m = pe as Extract<PiEvent, { type: 'message_end' }>;
          if (m.message?.role !== 'assistant') return;
          const text = extractAssistantText(m.message);
          if (!text) return;
          setItems(prev => [...prev, {
            key: `msg:${prev.length}:${text.slice(0, 16)}`,
            role: 'agent',
            text,
          }]);
          return;
        }
        case 'error':
          setItems(prev => [...prev, {
            key: `err:${prev.length}`,
            role: 'system',
            text: (pe as { message?: string }).message ?? 'agent error',
          }]);
          setBusy(false);
          return;
        // All other event types are uninteresting for the chat surface.
      }
    }

    return () => {
      es.close();
    };
  }, [project, setSelected, queryClient]);

  // Auto-scroll on new items.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items.length]);

  // ── Submit ──────────────────────────────────────────────────────────────
  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text || !project || busy) return;
    setDraft('');
    // Optimistically append the user turn — the server doesn't echo it.
    setItems(prev => [...prev, { key: `u:${prev.length}`, role: 'user', text }]);
    setBusy(true);
    try {
      await api.sendAgentMessage(project, text);
    } catch (err) {
      setItems(prev => [...prev, {
        key: `err:${prev.length}`,
        role: 'system',
        text: `send failed: ${(err as Error).message}`,
      }]);
      setBusy(false);
    }
  };

  const newChat = async () => {
    if (!project) return;
    setShowSessions(false);
    try {
      // Server emits `session_switched` over the SSE stream, which clears
      // local items and updates activeSessionPath — no local clear needed.
      await api.newAgentSession(project);
    } catch (err) {
      setItems(prev => [...prev, {
        key: `err:${prev.length}`,
        role: 'system',
        text: `new session failed: ${(err as Error).message}`,
      }]);
    }
  };

  const switchToSession = async (path: string) => {
    if (!project || path === activeSessionPath) {
      setShowSessions(false);
      return;
    }
    setShowSessions(false);
    try {
      await api.activateAgentSession(project, path);
      // SSE `session_switched` envelope carries the history.
    } catch (err) {
      setItems(prev => [...prev, {
        key: `err:${prev.length}`,
        role: 'system',
        text: `activate failed: ${(err as Error).message}`,
      }]);
    }
  };

  const deleteSession = async (path: string) => {
    if (!project) return;
    // Native confirm is good enough for a destructive action that only
    // touches a single JSONL on disk.
    if (!window.confirm('Delete this chat session? This cannot be undone.')) return;
    try {
      await api.deleteAgentSession(project, path);
      // Server emits `session_switched` if the deleted file was active.
      // For non-active deletions we just need to refresh the popover list.
      queryClient.invalidateQueries({ queryKey: ['agent-sessions', project] });
    } catch (err) {
      setItems(prev => [...prev, {
        key: `err:${prev.length}`,
        role: 'system',
        text: `delete failed: ${(err as Error).message}`,
      }]);
    }
  };

  return (
    <div className="flex flex-col h-full min-h-0 bg-cream-100">
      <div className="px-3 py-2 border-b border-cream-200 flex items-center justify-between relative">
        <div className="text-[11px] uppercase tracking-widest text-roast-light">Agent</div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowSessions(v => !v)}
            className="text-[11px] text-roast-medium hover:text-roast-dark"
            title="Switch between saved chat sessions"
          >
            history ({sessionList.data?.sessions.length ?? 0})
          </button>
          <button
            onClick={newChat}
            className="text-[11px] text-roast-medium hover:text-roast-dark"
            title="Start a new conversation"
          >
            new chat
          </button>
        </div>
        {showSessions && (
          <SessionPopover
            sessions={sessionList.data?.sessions ?? []}
            activePath={activeSessionPath}
            onPick={switchToSession}
            onDelete={deleteSession}
            onDismiss={() => setShowSessions(false)}
          />
        )}
      </div>

      {/* Auth / connection banners */}
      {authError && (
        <div className="px-3 py-2 text-[12px] bg-cream-200 text-roast-dark border-b border-cream-200">
          {authError}
        </div>
      )}
      {connError && !authError && (
        <div className="px-3 py-1 text-[11px] text-roast-light italic">
          {connError}
        </div>
      )}

      {/* Scrollback */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-2 min-h-0">
        {items.length === 0 && !authError && (
          <div className="text-roast-medium text-sm">
            Ask the agent about anything in this project's knowledge graph.
          </div>
        )}
        {items.map(it => <Bubble key={it.key} item={it} project={project} />)}
        {busy && <BusyDots />}
      </div>

      <form onSubmit={send} className="flex gap-1 p-3 border-t border-cream-200">
        <input
          value={draft}
          onChange={e => setDraft(e.target.value)}
          disabled={!project || !!authError}
          placeholder={authError ? 'agent not configured' : 'Ask something…'}
          className="flex-1 bg-cream-50 border border-cream-200 rounded px-2 py-1.5 text-sm text-roast-dark placeholder:text-roast-light focus:outline-none focus:ring-2 focus:ring-roast-light disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={!project || !!authError || busy || !draft.trim()}
          className="px-3 py-1.5 bg-roast-dark text-cream-50 rounded text-sm hover:bg-roast-medium disabled:opacity-50"
        >
          Send
        </button>
      </form>
    </div>
  );
}

// ── Session picker ────────────────────────────────────────────────────────

function SessionPopover({
  sessions, activePath, onPick, onDelete, onDismiss,
}: {
  sessions: UiAgentSessionInfo[];
  activePath: string | undefined;
  onPick: (path: string) => void;
  onDelete: (path: string) => void;
  onDismiss: () => void;
}) {
  // Click-outside dismiss via the backdrop layer behind the popover.
  return (
    <>
      <div className="fixed inset-0 z-10" onClick={onDismiss} />
      <div className="absolute right-3 top-full mt-1 z-20 w-[300px] max-h-[60vh] overflow-y-auto bg-cream-50 border border-cream-200 rounded shadow-lg">
        {sessions.length === 0 ? (
          <div className="p-3 text-[12px] text-roast-light italic">No saved sessions.</div>
        ) : sessions.map(s => {
          const isActive = s.isActive || s.path === activePath;
          return (
            <div
              key={s.path}
              className={
                'group flex items-stretch border-b border-cream-200 last:border-b-0 hover:bg-cream-100 transition ' +
                (isActive ? 'bg-cream-100' : '')
              }
            >
              <button
                onClick={() => onPick(s.path)}
                className="flex-1 text-left px-3 py-2 min-w-0"
                title={s.path}
              >
                <div className="text-[12px] text-roast-dark truncate">
                  {s.firstMessage || (s.name ? s.name : '(empty session)')}
                </div>
                <div className="text-[10px] text-roast-light font-mono mt-0.5 flex justify-between gap-2">
                  <span>{formatRelative(s.modified)}</span>
                  <span>{s.messageCount} msg{s.messageCount === 1 ? '' : 's'}</span>
                  {isActive && <span className="text-roast-medium uppercase tracking-wider">active</span>}
                </div>
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); onDelete(s.path); }}
                className="px-2 text-roast-light hover:text-red-700 opacity-0 group-hover:opacity-100 transition text-[14px]"
                title="Delete this session"
                aria-label="Delete session"
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
    </>
  );
}

function formatRelative(iso: string): string {
  const t = new Date(iso).getTime();
  const diffSec = Math.max(0, (Date.now() - t) / 1000);
  if (diffSec < 60) return 'just now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}

// ── Bubbles ────────────────────────────────────────────────────────────────

function Bubble({ item, project }: { item: ChatItem; project: string | null }) {
  if (item.role === 'user') {
    return (
      <div className="rounded-lg p-2 text-sm animate-fade-up bg-roast-dark text-cream-50 whitespace-pre-wrap">
        {item.text}
      </div>
    );
  }
  if (item.role === 'agent') {
    return (
      <div className="rounded-lg p-2 text-sm animate-fade-up bg-cream-50 border border-cream-200 text-roast-dark leading-snug">
        <AgentMarkdown text={item.text} project={project} />
      </div>
    );
  }
  if (item.role === 'tool') {
    return (
      <div
        className={
          'rounded px-2 py-1 text-[11px] font-mono animate-fade-up truncate ' +
          (item.toolError
            ? 'bg-red-50 border border-red-200 text-red-700'
            : 'bg-cream-50 border border-cream-200 text-roast-light')
        }
        title={item.text}
      >
        <span className="text-roast-medium">→ {item.toolName}</span>{' '}
        <span>{item.text.replace(item.toolName + ' ', '')}</span>
      </div>
    );
  }
  // system / error
  return (
    <div className="rounded p-2 text-[12px] italic bg-cream-50 border border-cream-200 text-roast-medium animate-fade-up">
      {item.text}
    </div>
  );
}

function BusyDots() {
  return (
    <div className="text-roast-light text-sm italic animate-fade-up">thinking…</div>
  );
}

// ── Inline citation rendering ─────────────────────────────────────────────

/**
 * Match a caret-prefixed UUID. The agent is instructed to use the full
 * 8-4-4-4-12 form. We anchor with the caret so we don't accidentally turn
 * a bare uuid (e.g. inside a tool-name string) into a chip.
 */
const CITATION_RE = /\^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;
const CITATION_CODE_PREFIX = 'coffee-cite:';

/**
 * Render assistant text as GFM markdown, with `^<uuid>` citations swapped
 * to clickable chips.
 *
 * Mechanism: we pre-rewrite each `^<uuid>` to backtick-wrapped
 * `coffee-cite:<uuid>` so the markdown parser sees it as inline code, then
 * intercept `<code>` elements in the rendered tree and turn the prefixed
 * ones into chips. This sidesteps writing a remark plugin and survives
 * being embedded inside bold/italic/links because markdown inline-code is
 * itself an inline node.
 */
function AgentMarkdown({ text, project }: { text: string; project: string | null }) {
  const rewritten = text.replace(CITATION_RE, (_m, uuid) => `\`${CITATION_CODE_PREFIX}${uuid}\``);
  return (
    <div className="prose prose-sm max-w-none prose-roast prose-p:my-1 prose-pre:my-2 prose-ul:my-1 prose-ol:my-1 prose-headings:my-2">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code(props) {
            const { children, className } = props as { children?: React.ReactNode; className?: string };
            const text = childrenToString(children);
            if (text.startsWith(CITATION_CODE_PREFIX)) {
              return <CitationChip nodeId={text.slice(CITATION_CODE_PREFIX.length)} project={project} />;
            }
            // Plain inline / fenced code: fall back to default-ish styling.
            // Fenced code gets a className like `language-ts` from the parser.
            const isFenced = !!className;
            return isFenced
              ? <code className={className}>{children}</code>
              : <code className="px-1 py-0.5 rounded bg-cream-100 border border-cream-200 text-[12px] font-mono">{children}</code>;
          },
          a({ children, href }) {
            // External links: open in a new tab so we don't blow away the UI.
            return <a href={href} target="_blank" rel="noreferrer" className="text-roast-medium underline">{children}</a>;
          },
        }}
      >
        {rewritten}
      </ReactMarkdown>
    </div>
  );
}

function childrenToString(children: React.ReactNode): string {
  if (typeof children === 'string') return children;
  if (Array.isArray(children)) return children.map(c => (typeof c === 'string' ? c : '')).join('');
  return '';
}

function CitationChip({ nodeId, project }: { nodeId: string; project: string | null }) {
  const setSelected = useUi(s => s.setSelected);
  // /nodes/:id at depth=0 just returns id + typeName — cheap to fetch and
  // React Query dedupes across multiple chips with the same id.
  const q = useQuery({
    queryKey: ['cite', project, nodeId],
    queryFn: () => (project ? api.loadNode(project, nodeId, 0) : Promise.resolve(null)),
    enabled: !!project,
    staleTime: 5 * 60_000,
  });
  const typeName = q.data?.typeName;
  return (
    <button
      onClick={() => setSelected(nodeId)}
      className="inline-flex items-center gap-1 align-baseline border border-cream-200 hover:border-roast-light hover:bg-cream-100 rounded px-1 py-0 mx-0.5 text-[10px] font-mono text-roast-medium transition"
      title={nodeId}
    >
      {typeName && <span className="text-roast-light">{typeName}</span>}
      <span className="text-roast-dark">{nodeId.slice(0, 8)}</span>
    </button>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

function extractAssistantText(msg: { content?: Array<{ type?: string; text?: string }> } | undefined): string {
  if (!msg?.content) return '';
  return msg.content
    .filter(c => c?.type === 'text' && typeof c.text === 'string')
    .map(c => c.text)
    .join('\n')
    .trim();
}

/**
 * Map a server-rendered `HistoryItem` into a `ChatItem`. Keeps tool chip
 * metadata (`toolName`, `toolError`) when the server signals the call
 * failed — without this, a switched-back session would lose the red
 * error styling on previously-broken tool calls.
 */
function historyToChatItem(h: HistoryItem, i: number): ChatItem {
  if (h.role === 'tool') {
    return {
      key: `h:${i}`,
      role: 'tool',
      toolName: h.toolName,
      text: h.text,
      toolError: h.toolError,
    };
  }
  return { key: `h:${i}`, role: h.role, text: h.text };
}

function describeToolCall(name: string, args: unknown): string {
  // Short, one-line summary for the tool chip. Long inputs are truncated;
  // hover shows full args via the `title` attribute on the chip.
  let body = '';
  if (args && typeof args === 'object') {
    const obj = args as Record<string, unknown>;
    const primary =
      obj['query'] ?? obj['pattern'] ?? obj['value'] ?? obj['id'] ?? obj['nodeId'] ?? obj['name'];
    if (typeof primary === 'string') body = primary;
    else body = JSON.stringify(obj);
  } else {
    body = String(args ?? '');
  }
  if (body.length > 80) body = body.slice(0, 77) + '…';
  return `${name} ${body}`.trim();
}
