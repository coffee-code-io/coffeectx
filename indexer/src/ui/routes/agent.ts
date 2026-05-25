/**
 * HTTP routes for the interactive UI agent.
 *
 *   GET  /api/p/:p/agent/stream             — SSE; pi events + envelopes
 *   POST /api/p/:p/agent/message            — body { text }; sends a user turn
 *   GET  /api/p/:p/agent/sessions           — list all sessions for the project
 *   POST /api/p/:p/agent/sessions/new       — create a new session, make active
 *   POST /api/p/:p/agent/sessions/activate  — body { path }; switch active
 *   POST /api/p/:p/agent/sessions/delete    — body { path }; remove a session
 *
 * Auth comes from `projects.<name>.agent.auth`. When unset, the stream
 * endpoint emits a single `error` envelope and closes; the UI surfaces that
 * to the user as a "configure agent.auth" hint.
 */

import type { FastifyInstance } from 'fastify';
import { getDb } from '../dbPool.js';
import {
  ensureActiveSession,
  getActiveSession,
  sendMessage,
  newSession,
  activateSession,
  deleteSession,
  listProjectSessions,
  renderHistory,
  type AgentEnvelope,
  type SessionListener,
} from '../agentSessions.js';

export async function registerAgentRoutes(app: FastifyInstance): Promise<void> {
  // ── SSE stream ────────────────────────────────────────────────────────────
  app.get<{ Params: { p: string } }>(
    '/api/p/:p/agent/stream',
    async (req, reply) => {
      let db;
      try { db = getDb(req.params.p); }
      catch (err) { reply.code(404); return { error: (err as Error).message }; }

      // SSE stream first-connect is the *only* path that auto-resumes the
      // most-recent JSONL. Message routing (below) no longer falls back to
      // continueRecent — that was the source of the "client says A, server
      // sends to B" bug.
      const session = await ensureActiveSession(req.params.p, db);
      reply.raw.setHeader('Content-Type', 'text/event-stream');
      reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
      reply.raw.setHeader('Connection', 'keep-alive');
      reply.raw.setHeader('X-Accel-Buffering', 'no');
      reply.raw.flushHeaders();

      const writeEnvelope = (env: unknown) => {
        try { reply.raw.write(`data: ${JSON.stringify(env)}\n\n`); }
        catch { /* socket closed; cleanup happens via 'close' listener */ }
      };

      if ('error' in session) {
        writeEnvelope({ kind: 'error', message: session.error.message });
        reply.raw.end();
        return;
      }

      // Include the resumed session's history so the client can render
       // the scrollback on connect — without this, a page reload showed
       // an empty chat panel while the popover still marked the session
       // as "active", making history-clicks on it short-circuit (=
       // looked broken).
      const history = renderHistory(session.session);
      writeEnvelope({
        kind: 'ready',
        activeSessionPath: session.activeSessionPath,
        history,
      });

      // The "listener" is the per-connection thing. After a session switch
      // the agentSessions module reattaches the same Set instance to the
      // new state, so this listener keeps firing without reconnecting.
      const listener: SessionListener = (env: AgentEnvelope) => writeEnvelope(env);
      session.listeners.add(listener);

      // Keep-alive comments every 25s — many proxies drop idle SSE streams
      // after 30s, and pi-coding-agent can sit silent for longer than that
      // while the LLM provider streams.
      const keepAlive = setInterval(() => {
        try { reply.raw.write(`: keep-alive\n\n`); }
        catch { /* ignore */ }
      }, 25_000);

      const cleanup = () => {
        clearInterval(keepAlive);
        // The listener Set is project-wide and shared with every state
        // built across session swaps — deleting once removes it from the
        // single source of truth.
        session.listeners.delete(listener);
      };
      req.raw.on('close', cleanup);
      req.raw.on('error', cleanup);

      return new Promise<void>(() => { /* never resolves */ });
    },
  );

  // ── User message ──────────────────────────────────────────────────────────
  app.post<{ Params: { p: string }; Body: { text?: string } }>(
    '/api/p/:p/agent/message',
    async (req, reply) => {
      const text = (req.body?.text ?? '').trim();
      if (!text) {
        reply.code(400);
        return { error: 'text is required' };
      }
      let db;
      try { db = getDb(req.params.p); }
      catch (err) { reply.code(404); return { error: (err as Error).message }; }

      // Trust the SSE layer to have established an active session. If the
      // user never opened the chat panel (no active session in memory),
      // create a fresh JSONL rather than resuming the most-recent one on
      // disk — otherwise an explicit history pick could be silently
      // overridden by `continueRecent`.
      let session = getActiveSession(req.params.p);
      if (!session) {
        const r = await newSession(req.params.p, db);
        if ('error' in r) {
          reply.code(412);
          return { error: r.error.message, reason: r.error.reason };
        }
        session = r;
      }

      try {
        await sendMessage(session, text);
        return { ok: true };
      } catch (err) {
        reply.code(409);
        return { error: (err as Error).message };
      }
    },
  );

  // ── List sessions ─────────────────────────────────────────────────────────
  app.get<{ Params: { p: string } }>(
    '/api/p/:p/agent/sessions',
    async (req, reply) => {
      try { getDb(req.params.p); }
      catch (err) { reply.code(404); return { error: (err as Error).message }; }
      try {
        const sessions = await listProjectSessions(req.params.p);
        return { sessions };
      } catch (err) {
        reply.code(500);
        return { error: (err as Error).message };
      }
    },
  );

  // ── New session ───────────────────────────────────────────────────────────
  app.post<{ Params: { p: string } }>(
    '/api/p/:p/agent/sessions/new',
    async (req, reply) => {
      let db;
      try { db = getDb(req.params.p); }
      catch (err) { reply.code(404); return { error: (err as Error).message }; }

      const r = await newSession(req.params.p, db);
      if ('error' in r) {
        reply.code(412);
        return { error: r.error.message };
      }
      return { ok: true, activeSessionPath: r.activeSessionPath };
    },
  );

  // ── Activate an existing session ──────────────────────────────────────────
  app.post<{ Params: { p: string }; Body: { path?: string } }>(
    '/api/p/:p/agent/sessions/activate',
    async (req, reply) => {
      const path = req.body?.path;
      if (!path || typeof path !== 'string') {
        reply.code(400);
        return { error: 'path is required' };
      }
      let db;
      try { db = getDb(req.params.p); }
      catch (err) { reply.code(404); return { error: (err as Error).message }; }

      const r = await activateSession(req.params.p, db, path);
      if ('error' in r) {
        reply.code(412);
        return { error: r.error.message };
      }
      return { ok: true, activeSessionPath: r.activeSessionPath };
    },
  );

  // ── Delete a session ──────────────────────────────────────────────────────
  app.post<{ Params: { p: string }; Body: { path?: string } }>(
    '/api/p/:p/agent/sessions/delete',
    async (req, reply) => {
      const path = req.body?.path;
      if (!path || typeof path !== 'string') {
        reply.code(400);
        return { error: 'path is required' };
      }
      let db;
      try { db = getDb(req.params.p); }
      catch (err) { reply.code(404); return { error: (err as Error).message }; }

      const r = await deleteSession(req.params.p, db, path);
      if ('error' in r) {
        // Mixed error union: auth-missing (412) vs not-found (404).
        const code = 'reason' in r.error ? 412 : 404;
        reply.code(code);
        return { error: r.error.message };
      }
      return { ok: true, activeSessionPath: r.activeSessionPath };
    },
  );
}
