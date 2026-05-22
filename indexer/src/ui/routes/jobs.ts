/**
 * /api/p/:p/jobs and /api/p/:p/scheduler — job control + liveness.
 */

import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@coffeectx/core';
import { getDb } from '../dbPool.js';
import {
  ensureJobsRegistered,
  setJobEnabled,
  queueJobTrigger,
} from '../../jobs/control.js';

const ALIVE_WINDOW_MS = 5_000;

export async function registerJobsRoutes(app: FastifyInstance): Promise<void> {
  // ── List all jobs for a project ───────────────────────────────────────────
  app.get<{ Params: { p: string } }>('/api/p/:p/jobs', async (req, reply) => {
    const cfg = loadConfig();
    if (!cfg.projects[req.params.p]) {
      reply.code(404);
      return { error: `unknown project "${req.params.p}"` };
    }
    const db = getDb(req.params.p, cfg);
    ensureJobsRegistered(db, cfg, req.params.p);
    return db.listJobs();
  });

  // ── One job with recent runs ──────────────────────────────────────────────
  app.get<{ Params: { p: string; job: string } }>(
    '/api/p/:p/jobs/:job',
    async (req, reply) => {
      const cfg = loadConfig();
      if (!cfg.projects[req.params.p]) {
        reply.code(404);
        return { error: `unknown project "${req.params.p}"` };
      }
      const db = getDb(req.params.p, cfg);
      ensureJobsRegistered(db, cfg, req.params.p);
      const job = db.getJob(req.params.job);
      if (!job) {
        reply.code(404);
        return { error: `unknown job "${req.params.job}"` };
      }
      return { job, recentRuns: db.listJobRuns(req.params.job, 10) };
    },
  );

  // ── Toggle enabled ────────────────────────────────────────────────────────
  app.post<{ Params: { p: string; job: string }; Body: { enabled?: boolean } }>(
    '/api/p/:p/jobs/:job/enabled',
    async (req, reply) => {
      const enabled = req.body?.enabled;
      if (typeof enabled !== 'boolean') {
        reply.code(400);
        return { error: 'body.enabled must be a boolean' };
      }
      const cfg = loadConfig();
      if (!cfg.projects[req.params.p]) {
        reply.code(404);
        return { error: `unknown project "${req.params.p}"` };
      }
      const db = getDb(req.params.p, cfg);
      try {
        setJobEnabled(db, cfg, req.params.p, req.params.job, enabled);
        return { name: req.params.job, enabled };
      } catch (err) {
        reply.code(400);
        return { error: (err as Error).message };
      }
    },
  );

  // ── Queue a manual trigger ────────────────────────────────────────────────
  app.post<{ Params: { p: string; job: string } }>(
    '/api/p/:p/jobs/:job/trigger',
    async (req, reply) => {
      const cfg = loadConfig();
      if (!cfg.projects[req.params.p]) {
        reply.code(404);
        return { error: `unknown project "${req.params.p}"` };
      }
      const db = getDb(req.params.p, cfg);
      if (!db.getJob(req.params.job)) {
        reply.code(404);
        return { error: `unknown job "${req.params.job}"` };
      }
      queueJobTrigger(db, req.params.job);
      return { queued: req.params.job };
    },
  );

  // ── Scheduler liveness ────────────────────────────────────────────────────
  app.get<{ Params: { p: string } }>(
    '/api/p/:p/scheduler',
    async (req, reply) => {
      const cfg = loadConfig();
      if (!cfg.projects[req.params.p]) {
        reply.code(404);
        return { error: `unknown project "${req.params.p}"` };
      }
      const db = getDb(req.params.p, cfg);
      const hb = db.readHeartbeat();
      if (!hb) return { alive: false, lastSeenAt: null, pid: null };
      // SQLite datetime('now') returns 'YYYY-MM-DD HH:MM:SS' in UTC.
      const isoUtc = hb.lastSeenAt.replace(' ', 'T') + 'Z';
      const lastMs = Date.parse(isoUtc);
      const alive = !Number.isNaN(lastMs) && Date.now() - lastMs < ALIVE_WINDOW_MS;
      return { alive, lastSeenAt: isoUtc, pid: hb.pid };
    },
  );
}
