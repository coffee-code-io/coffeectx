/**
 * Per-project pi-coding-agent session manager for the interactive UI chat.
 *
 * Model: each project owns ONE *active* pi session at a time, persisted as a
 * JSONL under `~/.coffeecode/sessions/<project>/ui/`. Past sessions live
 * alongside it in the same dir; the UI lists them and lets the user switch.
 *
 * Switching:
 *  - "New chat" creates a fresh JSONL and makes it active. Old files stay.
 *  - Activating an existing session tears down the current `AgentSession`,
 *    opens the chosen file via `SessionManager.open`, and emits a `history`
 *    envelope so the client can render the prior turns.
 *
 * Why per-project (not per-tab):
 *  - Pi sessions hold their own conversation state internally; calling
 *    `prompt()` from two browser tabs simultaneously would interleave turns.
 *    Routing every UI client through a single active session keeps the
 *    conversation coherent and matches how skills already do it.
 */

import { mkdirSync, readdirSync, existsSync, statSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import {
  createAgentSession,
  SessionManager,
  type AgentSession,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import {
  COFFEECODE_DIR,
  loadConfig,
  resolveAgentAuth,
  type AuthSettings,
  type Db,
} from '@coffeectx/core';
import { buildResourceLoader } from '../agentRun/skillResourceLoader.js';
import { buildPiAuth } from '../agentRun/auth.js';
import { buildGraphTools, buildNavigateTool } from '../agentRun/piTools.js';
import { maybeExecElevatedTool, setSecretsProjectEnv } from '../agentRun/secretsTool.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SESSION_ROOT = join(COFFEECODE_DIR, 'sessions');
const UI_AGENT_PROMPT_PATH = resolve(__dirname, '../../prompts/ui-agent.md');
/** The agent's cwd. Matches what `runSkillInteractive` uses. */
const PROJECT_ROOT = resolve(__dirname, '../../..');

// ── SSE envelopes ──────────────────────────────────────────────────────────

/**
 * Events broadcast over SSE to all subscribers of one project's session.
 *
 *  - `agent` — raw pi event, payload is from `session.subscribe`.
 *  - `navigate` — emitted by the `navigate_to_node` tool side-effect.
 *  - `session_switched` — fired when the active session file changes (new
 *    chat, or user picked a past session); carries the rendered history of
 *    the newly-active session so the client can re-render the scrollback.
 *
 * Inline `^<uuid>` citations the agent embeds in its assistant text are
 * parsed CLIENT-SIDE — we no longer scan tool results server-side, since
 * the agent already cherry-picks the relevant nodes.
 */
export type AgentEnvelope =
  | { kind: 'agent'; event: unknown }
  | { kind: 'navigate'; nodeId: string; reason?: string }
  | { kind: 'session_switched'; activeSessionPath: string | undefined; history: HistoryItem[] };

/** Minimal rendered shape we send to the client on session switch. */
export type HistoryItem =
  | { role: 'user'; text: string }
  | { role: 'agent'; text: string }
  | { role: 'tool'; toolName: string; text: string; toolError?: boolean };

export type SessionListener = (event: AgentEnvelope) => void;

// ── Per-project state ──────────────────────────────────────────────────────

interface PerProjectState {
  projectName: string;
  db: Db;
  auth: AuthSettings;
  session: AgentSession;
  /** Absolute path of the currently active JSONL. */
  activeSessionPath: string | undefined;
  listeners: Set<SessionListener>;
  busy: boolean;
  abort: AbortController;
}

const PROJECT_STATE = new Map<string, PerProjectState>();

// ── Public API ─────────────────────────────────────────────────────────────

export interface AgentNotConfiguredError {
  reason: 'auth-missing' | 'auth-invalid';
  message: string;
}

/** SessionInfo subset we expose to the UI. */
export interface UiSessionInfo {
  /** Absolute path of the JSONL — used as the activate key. */
  path: string;
  id: string;
  name?: string;
  created: string; // ISO
  modified: string; // ISO
  messageCount: number;
  firstMessage: string;
  isActive: boolean;
}

/**
 * Long-lived listener Set, one per project. SSE connections register here
 * once and keep firing across session switches — `tearDown` / `newSession` /
 * `activateSession` install the same Set instance on every fresh
 * `PerProjectState`, so a route handler that captures it at connect time
 * doesn't go stale when the active session is swapped.
 *
 * Previously we built a fresh Set per state and copied entries forward;
 * the SSE route's captured reference then pointed at an orphaned Set after
 * the first switch, so `cleanup()` on disconnect leaked the listener into
 * the still-live one. This map is the single source of truth.
 */
const PROJECT_LISTENERS = new Map<string, Set<SessionListener>>();

function listenersFor(projectName: string): Set<SessionListener> {
  let s = PROJECT_LISTENERS.get(projectName);
  if (!s) {
    s = new Set();
    PROJECT_LISTENERS.set(projectName, s);
  }
  return s;
}

/** Return the cached active session if one exists. Never builds a new one;
 *  callers handle the null branch (typically by calling `newSession`). */
export function getActiveSession(projectName: string): PerProjectState | null {
  return PROJECT_STATE.get(projectName) ?? null;
}

/**
 * First-connect bootstrap for the SSE stream: returns the cached active
 * session, or builds one from the most recent JSONL on disk (creating an
 * empty one if the dir is empty). This is the only path that auto-resumes;
 * `POST /agent/message` no longer falls back here — see route handler.
 */
export async function ensureActiveSession(
  projectName: string,
  db: Db,
): Promise<PerProjectState | { error: AgentNotConfiguredError }> {
  const existing = PROJECT_STATE.get(projectName);
  if (existing) return existing;

  const authOrErr = resolveAuthOrError(projectName);
  if ('error' in authOrErr) return authOrErr;

  const sessionDir = sessionDirFor(projectName);
  mkdirSync(sessionDir, { recursive: true });
  const sessionManager = SessionManager.continueRecent(PROJECT_ROOT, sessionDir);

  const state = await buildState({
    projectName, db, auth: authOrErr.auth, sessionManager,
  });
  PROJECT_STATE.set(projectName, state);
  return state;
}

/** Send a user message; non-blocking (the agent loop runs in background). */
export async function sendMessage(state: PerProjectState, text: string): Promise<void> {
  if (state.busy) {
    throw new Error('Agent is still processing the previous message');
  }
  state.busy = true;
  void runPrompt(state, text);
}

/**
 * Create a brand-new session JSONL and make it active. The previous session
 * is aborted + disposed (its file stays on disk so the user can pick it
 * later from the session list). Connected SSE listeners are carried over,
 * so the user's chat panel doesn't have to reconnect. Emits a
 * `session_switched` envelope so the client clears its scrollback.
 */
export async function newSession(
  projectName: string,
  db: Db,
): Promise<PerProjectState | { error: AgentNotConfiguredError }> {
  const authOrErr = resolveAuthOrError(projectName);
  if ('error' in authOrErr) return authOrErr;

  await tearDown(projectName);

  const sessionDir = sessionDirFor(projectName);
  mkdirSync(sessionDir, { recursive: true });
  const sessionManager = SessionManager.create(PROJECT_ROOT, sessionDir);

  const state = await buildState({
    projectName, db, auth: authOrErr.auth, sessionManager,
  });
  PROJECT_STATE.set(projectName, state);
  // listeners.add(...) carry-forward is gone — every state points at the
  // same Set instance via listenersFor(projectName), so SSE clients stay
  // attached automatically across swaps.
  broadcast(state, { kind: 'session_switched', activeSessionPath: state.activeSessionPath, history: [] });
  return state;
}

/**
 * Switch the active session to an existing JSONL. Replays the prior
 * conversation in the `session_switched` envelope's `history` field so the
 * client can re-render the scrollback.
 */
export async function activateSession(
  projectName: string,
  db: Db,
  sessionPath: string,
): Promise<PerProjectState | { error: AgentNotConfiguredError | { message: string } }> {
  const authOrErr = resolveAuthOrError(projectName);
  if ('error' in authOrErr) return authOrErr;

  // Constrain to files inside this project's session dir so a malicious
  // client can't open arbitrary paths.
  const sessionDir = sessionDirFor(projectName);
  const absPath = resolve(sessionPath);
  if (!absPath.startsWith(resolve(sessionDir) + '/') || !existsSync(absPath)) {
    return { error: { message: `Session file not found in project: ${sessionPath}` } };
  }

  await tearDown(projectName);
  const sessionManager = SessionManager.open(absPath, sessionDir);
  const state = await buildState({
    projectName, db, auth: authOrErr.auth, sessionManager,
  });
  PROJECT_STATE.set(projectName, state);

  const history = renderHistory(state.session);
  broadcast(state, { kind: 'session_switched', activeSessionPath: state.activeSessionPath, history });
  return state;
}

/**
 * Delete a saved session JSONL. If it happens to be the active one, the
 * live `AgentSession` is torn down first and the project is rebound to the
 * most-recent remaining session — or a fresh one if no others survive.
 *
 * Returns the new active path (or undefined if no project state exists yet,
 * e.g. when deleting from an offline UI before anything has been streamed).
 */
export async function deleteSession(
  projectName: string,
  db: Db,
  sessionPath: string,
): Promise<{ activeSessionPath: string | undefined } | { error: AgentNotConfiguredError | { message: string } }> {
  const sessionDir = sessionDirFor(projectName);
  const absPath = resolve(sessionPath);
  if (!absPath.startsWith(resolve(sessionDir) + '/') || !existsSync(absPath)) {
    return { error: { message: `Session file not found in project: ${sessionPath}` } };
  }

  const cur = PROJECT_STATE.get(projectName);
  const wasActive = cur?.activeSessionPath === absPath;

  // If we're killing the active session, abort+dispose first so pi releases
  // the file handle and any in-flight prompt gets cancelled. Listeners
  // remain in the project-wide `listenersFor(projectName)` Set across the
  // tear-down + rebuild so SSE clients keep firing.
  if (wasActive) {
    await tearDown(projectName);
  }

  try {
    rmSync(absPath, { force: true });
  } catch (err) {
    // Re-bind whatever we tore down so the project isn't left without a
    // live session on a delete failure.
    if (wasActive) {
      const authOrErr = resolveAuthOrError(projectName);
      if (!('error' in authOrErr)) {
        try {
          const sm = SessionManager.continueRecent(PROJECT_ROOT, sessionDir);
          const state = await buildState({
            projectName, db, auth: authOrErr.auth, sessionManager: sm,
          });
          PROJECT_STATE.set(projectName, state);
        } catch { /* leave PROJECT_STATE empty — ensureActiveSession will rebuild on next connect */ }
      }
    }
    return { error: { message: `delete failed: ${(err as Error).message}` } };
  }

  // If the deleted file wasn't active there's nothing else to do — the
  // session list reads from disk so the UI will refresh on its own.
  if (!wasActive) {
    return { activeSessionPath: cur?.activeSessionPath };
  }

  // Rebind: prefer continuing whatever's left on disk, else create new.
  const authOrErr = resolveAuthOrError(projectName);
  if ('error' in authOrErr) return authOrErr;

  const hasSurvivors = hasAnySessionFile(sessionDir);
  const sessionManager = hasSurvivors
    ? SessionManager.continueRecent(PROJECT_ROOT, sessionDir)
    : SessionManager.create(PROJECT_ROOT, sessionDir);

  const state = await buildState({
    projectName, db, auth: authOrErr.auth, sessionManager,
  });
  PROJECT_STATE.set(projectName, state);

  // Tell connected clients: we switched (their old session is gone). For
  // survivors we replay history; for a freshly-created session it's empty.
  const history = hasSurvivors ? renderHistory(state.session) : [];
  broadcast(state, { kind: 'session_switched', activeSessionPath: state.activeSessionPath, history });
  return { activeSessionPath: state.activeSessionPath };
}

/** List all sessions for a project, newest first. */
export async function listProjectSessions(projectName: string): Promise<UiSessionInfo[]> {
  const sessionDir = sessionDirFor(projectName);
  if (!existsSync(sessionDir)) return [];
  const infos = await SessionManager.list(PROJECT_ROOT, sessionDir);
  const activePath = PROJECT_STATE.get(projectName)?.activeSessionPath;
  return infos
    .map(info => ({
      path: info.path,
      id: info.id,
      name: info.name,
      created: info.created.toISOString(),
      modified: info.modified.toISOString(),
      messageCount: info.messageCount,
      firstMessage: info.firstMessage,
      isActive: info.path === activePath,
    }))
    .sort((a, b) => b.modified.localeCompare(a.modified));
}

/**
 * Dispose every session (called on UI server shutdown). Pi exposes
 * `session.abort()` (async) and `session.dispose()` (sync); without abort
 * the Node event loop refuses to exit until the in-flight LLM request
 * settles, so we await abort per session under a deadline.
 */
export async function disposeAll(): Promise<void> {
  const PER_SESSION_ABORT_DEADLINE_MS = 3_000;
  const tasks: Promise<void>[] = [];
  for (const state of PROJECT_STATE.values()) {
    tasks.push((async () => {
      try { state.abort.abort(); } catch { /* ok */ }
      try { await raceWithTimeout(state.session.abort(), PER_SESSION_ABORT_DEADLINE_MS); }
      catch { /* either timed out or pi threw — fall through to dispose */ }
      try { state.session.dispose(); } catch { /* ok */ }
    })());
  }
  await Promise.allSettled(tasks);
  PROJECT_STATE.clear();
}

// ── Internals ──────────────────────────────────────────────────────────────

interface BuildArgs {
  projectName: string;
  db: Db;
  auth: AuthSettings;
  sessionManager: SessionManager;
}

async function buildState(args: BuildArgs): Promise<PerProjectState> {
  // Resolve secrets project into env so `exec_elevated` can pick it up.
  setSecretsProjectEnv(args.projectName);
  const piAuth = buildPiAuth(args.auth);

  // Pre-allocate so the tools' closures see the eventual state object.
  // The listeners Set is the project-wide one — every `buildState` returns
  // a state pointing at the same `Set` instance, so SSE listeners survive
  // every session swap (`newSession`, `activateSession`, `deleteSession`)
  // without the route handler needing to re-register.
  const state: PerProjectState = {
    projectName: args.projectName,
    db: args.db,
    auth: args.auth,
    session: null as unknown as AgentSession,
    activeSessionPath: undefined,
    listeners: listenersFor(args.projectName),
    busy: false,
    abort: new AbortController(),
  };

  const navigateTool = buildNavigateTool((nodeId, reason) => {
    broadcast(state, { kind: 'navigate', nodeId, reason });
  });

  const customTools: ToolDefinition[] = [
    ...buildGraphTools(args.db, { allowInsert: false }),
    navigateTool,
    // Global `secrets.loadIntoAgents` flag injects `exec_elevated` here.
    // Listed in the tools allowlist too so the UI agent can actually call
    // it when the flag is on — there's no per-skill gate for this agent.
    ...maybeExecElevatedTool(),
  ];
  const toolNames = customTools.map(t => t.name);

  // UI agent role/instructions go into pi's `appendSystemPrompt` — pi
  // splices them into the system prompt on every turn, keeping the user
  // turn (and the JSONL preview) clean. Resolved at session-build time
  // so a hot-reloaded prompt picks up on the next "new chat" without a
  // process restart. Failures are surfaced into the chat stream so the
  // user sees them rather than silently running without instructions.
  let appendSystemPrompt: string[] | undefined;
  try {
    appendSystemPrompt = [readFileSync(UI_AGENT_PROMPT_PATH, 'utf-8')];
  } catch (err) {
    broadcast(state, {
      kind: 'agent',
      event: { type: 'error', message: `failed to load ui-agent prompt: ${(err as Error).message}` },
    });
  }

  // Pi-native skill loader filtered by the project's `uiAgent` bucket —
  // the agent's `/skill:<name>` slash commands and system-prompt entries
  // only include skills the user explicitly opted in for the UI agent.
  const resourceLoader = await buildResourceLoader({
    projectName: args.projectName,
    target: 'uiAgent',
    cwd: PROJECT_ROOT,
    appendSystemPrompt,
  });

  const { session } = await createAgentSession({
    cwd: PROJECT_ROOT,
    model: piAuth.model,
    authStorage: piAuth.authStorage,
    sessionManager: args.sessionManager,
    customTools,
    tools: toolNames,
    noTools: 'builtin',
    resourceLoader,
  });
  state.session = session;
  state.activeSessionPath = session.sessionFile;

  session.subscribe(event => {
    broadcast(state, { kind: 'agent', event });
  });

  // Intentionally NO `prompt()` call here for fresh sessions — that would
  // hit the LLM provider before the user has typed anything. We defer the
  // prime to the first real user turn (see runPrompt).
  return state;
}

async function runPrompt(state: PerProjectState, text: string): Promise<void> {
  // Role instructions land in `appendSystemPrompt` on the resource
  // loader (see `buildState` below); pi splices them into the system
  // prompt on every turn, so we no longer need to prepend them to the
  // user's first message. The session JSONL stays clean — each user
  // turn is exactly what the user typed.
  try {
    await state.session.prompt(text);
  } catch (err) {
    broadcast(state, {
      kind: 'agent',
      event: { type: 'error', message: (err as Error).message },
    });
  } finally {
    state.busy = false;
  }
}

/**
 * Drop the active session for a project (abort + dispose), preserving the
 * JSONL on disk. The project's listener Set lives in
 * `PROJECT_LISTENERS` and is shared with every freshly-built state, so
 * tear-down doesn't touch listener registrations — SSE clients stay
 * connected across switches without reconnecting.
 */
async function tearDown(projectName: string): Promise<void> {
  const prev = PROJECT_STATE.get(projectName);
  if (!prev) return;
  try { prev.abort.abort(); } catch { /* ok */ }
  try { await raceWithTimeout(prev.session.abort(), 3_000); } catch { /* ignore */ }
  try { prev.session.dispose(); } catch { /* ok */ }
  PROJECT_STATE.delete(projectName);
}

function broadcast(state: PerProjectState, env: AgentEnvelope): void {
  for (const fn of state.listeners) {
    try { fn(env); } catch { /* ignore broken subscribers */ }
  }
}

/**
 * Render a session's persisted messages into the flat scrollback shape the
 * web UI expects. Walks every message in order, emitting:
 *
 *   - user messages → `{ role: 'user', text }`
 *   - assistant messages → in source order: each `toolCall` block becomes
 *     a `{ role: 'tool', toolName, text }` chip; the remaining text
 *     content becomes a single `{ role: 'agent', text }` bubble at the
 *     end (matches the live-stream rendering where text arrives via
 *     `message_end` after every `tool_execution_start` for the same
 *     turn).
 *   - toolResult messages → patch the matching `tool` chip with
 *     `toolError: true` so failures stay visible across session swaps.
 *
 * Without the tool chips, switching between sessions in the popover
 * silently wiped every previously-rendered tool call from the chat.
 */
export function renderHistory(session: AgentSession): HistoryItem[] {
  const out: HistoryItem[] = [];
  // Index tool chips by toolCallId so toolResult messages can flip the
  // error flag in place.
  const toolByCallId = new Map<string, { role: 'tool'; toolName: string; text: string; toolError?: boolean }>();

  for (const msg of session.messages) {
    const m = msg as { role?: string; content?: unknown; toolCallId?: string; toolName?: string; isError?: boolean };

    if (m.role === 'user') {
      let text = extractText(m.content);
      if (!text) continue;
      // Back-compat: sessions captured before we moved instructions to
      // `appendSystemPrompt` had the UI agent prompt appended behind a
      // `\n---\n<system-instructions>…</system-instructions>` delimiter
      // on the first user turn. Strip that suffix when replaying legacy
      // JSONLs so the user only sees what they actually typed.
      text = stripLegacySystemInstructions(text);
      if (!text) continue;
      out.push({ role: 'user', text });
      continue;
    }

    if (m.role === 'assistant') {
      // Surface tool calls in source order alongside the assistant's
      // text, mirroring the live event stream (tool_execution_start
      // chips interleave with message_end text).
      if (Array.isArray(m.content)) {
        for (const block of m.content as Array<{ type?: string; id?: string; name?: string; arguments?: unknown }>) {
          if (block?.type !== 'toolCall') continue;
          const chip: { role: 'tool'; toolName: string; text: string; toolError?: boolean } = {
            role: 'tool',
            toolName: block.name ?? '?',
            text: describeToolCall(block.name ?? '?', block.arguments),
          };
          out.push(chip);
          if (block.id) toolByCallId.set(block.id, chip);
        }
      }
      const text = extractText(m.content);
      if (text) out.push({ role: 'agent', text });
      continue;
    }

    if (m.role === 'toolResult') {
      if (m.isError && m.toolCallId) {
        const chip = toolByCallId.get(m.toolCallId);
        if (chip) chip.toolError = true;
      }
      // Tool result text isn't surfaced in the UI today (live stream
      // doesn't render it either) — only the error flag matters here.
      continue;
    }
  }
  return out;
}

/**
 * One-line chip text for a persisted tool call. Mirrors the live-side
 * `describeToolCall` in the webui — keep them in sync.
 */
function describeToolCall(name: string, args: unknown): string {
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

function stripLegacySystemInstructions(text: string): string {
  const idx = text.indexOf('<system-instructions>');
  if (idx === -1) return text;
  return text.slice(0, idx).replace(/\n+---\n*$/, '').trimEnd();
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((c: { type?: string }) => c?.type === 'text')
    .map((c: { text?: string }) => c.text ?? '')
    .join('\n')
    .trim();
}

function resolveAuthOrError(projectName: string): { auth: AuthSettings } | { error: AgentNotConfiguredError } {
  const cfg = loadConfig();
  const auth = resolveAgentAuth(cfg, projectName);
  if (!auth.model) {
    return {
      error: {
        reason: 'auth-missing',
        message:
          `No agent auth configured for project "${projectName}". ` +
          `Add \`projects.${projectName}.agent.auth\` (authType + model + apiKey) to ~/.coffeecode/config.yaml.`,
      },
    };
  }
  try {
    buildPiAuth(auth);
    return { auth };
  } catch (err) {
    return { error: { reason: 'auth-invalid', message: (err as Error).message } };
  }
}

function raceWithTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([
    p,
    new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), ms)),
  ]);
}

function sessionDirFor(projectName: string): string {
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(SESSION_ROOT, safe(projectName), 'ui');
}

function hasAnySessionFile(dir: string): boolean {
  if (!existsSync(dir)) return false;
  try {
    return readdirSync(dir).some(f => f.endsWith('.jsonl') && statSync(join(dir, f)).size > 0);
  } catch { return false; }
}
