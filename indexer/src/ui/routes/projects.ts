/**
 * /api/projects — list projects and toggle their `enabled` flag.
 */

import { existsSync } from 'node:fs';
import { loadConfig, updateConfig, listEnabledProjects } from '@coffeectx/core';
import type { FastifyInstance } from 'fastify';

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
}
