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
import { homedir } from 'node:os';
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
  loadConfig,
  resolveAgentAuth,
  type AuthSettings,
  type Db,
} from '@coffeectx/core';
import { buildResourceLoader } from '../agentRun/skillResourceLoader.js';
import { buildPiAuth } from '../agentRun/auth.js';
import { buildGraphTools, buildNavigateTool } from '../agentRun/piTools.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SESSION_ROOT = join(homedir(), '.coffeecode', 'sessions');
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
export interface HistoryItem {
  role: 'user' | 'agent';
  text: string;
}

export type SessionListener = (event: AgentEnvelope) => void;

// ── Per-project state ──────────────────────────────────────────────────────

interface PerProjectState {
  projectName: string;
  db: Db;
  auth: AuthSettings;
  session: AgentSession;
  /** Absolute path of the currently active JSONL. */
  activeSessionPath: string | undefined;
  /**
   * True until the session has received its first real user turn. We plant
   * the system prompt by *prepending* it to that first user message rather
   * than firing a standalone `prompt()` call on session creation — that
   * avoided a wasted LLM round-trip per "new chat" (it also meant pi's
   * `SessionInfo.firstMessage` was returning the system blob instead of
   * the user's real first message).
   */
  needsPriming: boolean;
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

/** Lazily build (or fetch the cached) active session for a project. */
export async function getOrCreateSession(
  projectName: string,
  db: Db,
): Promise<PerProjectState | { error: AgentNotConfiguredError }> {
  const existing = PROJECT_STATE.get(projectName);
  if (existing) return existing;

  const authOrErr = resolveAuthOrError(projectName);
  if ('error' in authOrErr) return authOrErr;

  // Resume the most recent JSONL; pi creates one if the dir is empty.
  const sessionDir = sessionDirFor(projectName);
  mkdirSync(sessionDir, { recursive: true });
  const sessionManager = SessionManager.continueRecent(PROJECT_ROOT, sessionDir);
  const needsPriming = !hasAnySessionFile(sessionDir);

  const state = await buildState({
    projectName, db, auth: authOrErr.auth, sessionManager, needsPriming,
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

  const carriedListeners = await tearDown(projectName);

  const sessionDir = sessionDirFor(projectName);
  mkdirSync(sessionDir, { recursive: true });
  const sessionManager = SessionManager.create(PROJECT_ROOT, sessionDir);

  const state = await buildState({
    projectName, db, auth: authOrErr.auth, sessionManager, needsPriming: true,
  });
  for (const l of carriedListeners) state.listeners.add(l);
  PROJECT_STATE.set(projectName, state);
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

  const carriedListeners = await tearDown(projectName);
  const sessionManager = SessionManager.open(absPath, sessionDir);
  const state = await buildState({
    projectName, db, auth: authOrErr.auth, sessionManager, needsPriming: false,
  });
  for (const l of carriedListeners) state.listeners.add(l);
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
  // the file handle and any in-flight prompt gets cancelled. Listeners are
  // carried over so the SSE clients stay connected through the rebind.
  let carriedListeners: Set<SessionListener> = new Set();
  if (wasActive) {
    carriedListeners = await tearDown(projectName);
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
            projectName, db, auth: authOrErr.auth, sessionManager: sm, needsPriming: false,
          });
          for (const l of carriedListeners) state.listeners.add(l);
          PROJECT_STATE.set(projectName, state);
        } catch { /* leave PROJECT_STATE empty — getOrCreateSession will rebuild on next connect */ }
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
    projectName, db, auth: authOrErr.auth, sessionManager, needsPriming: !hasSurvivors,
  });
  for (const l of carriedListeners) state.listeners.add(l);
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
  /**
   * False for fresh sessions (we'll prepend the UI agent prompt to the
   * user's first message), true for resumed sessions that already carry
   * their priming turn in the JSONL.
   */
  needsPriming: boolean;
}

async function buildState(args: BuildArgs): Promise<PerProjectState> {
  const piAuth = buildPiAuth(args.auth);

  // Pre-allocate so the tools' closures see the eventual state object.
  const state: PerProjectState = {
    projectName: args.projectName,
    db: args.db,
    auth: args.auth,
    session: null as unknown as AgentSession,
    activeSessionPath: undefined,
    needsPriming: args.needsPriming,
    listeners: new Set(),
    busy: false,
    abort: new AbortController(),
  };

  const navigateTool = buildNavigateTool((nodeId, reason) => {
    broadcast(state, { kind: 'navigate', nodeId, reason });
  });

  const customTools: ToolDefinition[] = [
    ...buildGraphTools(args.db, { allowInsert: false }),
    navigateTool,
  ];
  const toolNames = customTools.map(t => t.name);

  // Pi-native skill loader filtered by the project's `uiAgent` bucket —
  // the agent's `/skill:<name>` slash commands and system-prompt entries
  // only include skills the user explicitly opted in for the UI agent.
  const resourceLoader = await buildResourceLoader({
    projectName: args.projectName,
    target: 'uiAgent',
    cwd: PROJECT_ROOT,
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
  // On the first user turn of a fresh session, prepend the UI agent
  // prompt. We embed it as the same prompt() so pi sees a single user
  // message — that keeps `SessionInfo.firstMessage` aligned with what the
  // user actually typed (renderHistory drops the priming preamble by
  // length heuristic; the session-list preview uses pi's own truncation
  // and only shows the first ~80 chars, so as long as the user's text
  // comes FIRST the preview reads right).
  let payload = text;
  if (state.needsPriming) {
    try {
      const uiPrompt = readFileSync(UI_AGENT_PROMPT_PATH, 'utf-8');
      // User text first, then the system instructions tucked behind a
      // separator. Pi's first-message extractor reads the literal head of
      // the first user message, so leading with the real query keeps the
      // session-switcher preview meaningful.
      payload = `${text}\n\n---\n\n<system-instructions>\n${uiPrompt}\n</system-instructions>`;
    } catch (err) {
      broadcast(state, {
        kind: 'agent',
        event: { type: 'error', message: `failed to load ui-agent prompt: ${(err as Error).message}` },
      });
    }
    state.needsPriming = false;
  }
  try {
    await state.session.prompt(payload);
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
 * JSONL on disk. Returns the listener set so the caller can hand it to the
 * replacement session — that's how SSE clients stay connected across
 * switches without having to reconnect.
 */
async function tearDown(projectName: string): Promise<Set<SessionListener>> {
  const prev = PROJECT_STATE.get(projectName);
  if (!prev) return new Set();
  try { prev.abort.abort(); } catch { /* ok */ }
  try { await raceWithTimeout(prev.session.abort(), 3_000); } catch { /* ignore */ }
  try { prev.session.dispose(); } catch { /* ok */ }
  PROJECT_STATE.delete(projectName);
  return prev.listeners;
}

function broadcast(state: PerProjectState, env: AgentEnvelope): void {
  for (const fn of state.listeners) {
    try { fn(env); } catch { /* ignore broken subscribers */ }
  }
}

function renderHistory(session: AgentSession): HistoryItem[] {
  const out: HistoryItem[] = [];
  for (const msg of session.messages) {
    // Pi's AgentMessage union — we only care about role-tagged ones with
    // text content. ToolResult messages and assistant tool_call segments
    // are skipped (history replay shows the conversation, not the work).
    const m = msg as { role?: string; content?: unknown };
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    let text = extractText(m.content);
    if (!text) continue;
    // The first user turn of any fresh session has the UI agent prompt
    // appended behind a `---\n<system-instructions>…</system-instructions>`
    // delimiter (see runPrompt). Strip it from history so the user only
    // sees what they actually typed.
    text = stripSystemInstructions(text);
    if (!text) continue;
    out.push({ role: m.role === 'user' ? 'user' : 'agent', text });
  }
  return out;
}

function stripSystemInstructions(text: string): string {
  const idx = text.indexOf('<system-instructions>');
  if (idx === -1) return text;
  // Also peel off the preceding "\n\n---\n\n" separator we wrote alongside.
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
