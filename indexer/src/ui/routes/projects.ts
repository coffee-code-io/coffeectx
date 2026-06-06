/**
 * /api/projects — list projects and toggle their `enabled` flag.
 */

import { existsSync } from 'node:fs';
import { loadConfig, updateConfig, listEnabledProjects } from '@coffeectx/core';
import type { FastifyInstance } from 'fastify';
import { invalidate as invalidateDb } from '../dbPool.js';

export async function registerProjectsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/projects', async () => {
    const cfg = loadConfig();
    const enabled = new Set(listEnabledProjects(cfg));
    return Object.entries(cfg.projects).map(([name, p]) => ({
      name,
      enabled: enabled.has(name),
      repoPath: p.repoPath ?? null,
      hasDb: existsSync(p.db),
      isActive: cfg.active === name,
    }));
  });

  app.post<{ Params: { name: string }; Body: { enabled?: boolean } }>(
    '/api/projects/:name/enabled',
    async (req, reply) => {
      const { name } = req.params;
      const { enabled } = req.body ?? {};
      if (typeof enabled !== 'boolean') {
        reply.code(400);
        return { error: 'body.enabled must be a boolean' };
      }
      try {
        updateConfig(cfg => {
          const p = cfg.projects[name];
          if (!p) throw new Error(`project "${name}" not in config`);
          p.enabled = enabled;
        });
      } catch (err) {
        reply.code(404);
        return { error: (err as Error).message };
      }
      return { name, enabled };
    },
  );

  // POST /api/projects/:name/refresh
  // Drops the cached Db handle for this project. The next request opens a
  // fresh SQLite connection — required after an external `restore` /
  // `reset` swap of the .db file, since the held connection keeps
  // referring to the pre-swap inode (and its WAL/shm pair). Without this
  // hook the UI would serve stale rows until the server process restart.
  app.post<{ Params: { name: string } }>(
    '/api/projects/:name/refresh',
    async (req) => {
      const { name } = req.params;
      const wasOpen = invalidateDb(name);
      return { name, reopened: wasOpen };
    },
  );
}
