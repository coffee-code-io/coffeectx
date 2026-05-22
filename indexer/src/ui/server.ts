/**
 * Fastify app for the coffeectx web UI. See `index.ts` for the bin entry.
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastify from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { registerProjectsRoutes } from './routes/projects.js';
import { registerNodesRoutes } from './routes/nodes.js';
import { registerJobsRoutes } from './routes/jobs.js';
import { closeAll } from './dbPool.js';

export interface ServerOptions {
  host: string;
  port: number;
}

export async function startServer(opts: ServerOptions): Promise<void> {
  const app = fastify({ logger: false });

  await app.register(fastifyCors, {
    // Permissive in dev so Vite can hit the API from :5173.
    origin: true,
    credentials: true,
  });

  await registerProjectsRoutes(app);
  await registerNodesRoutes(app);
  await registerJobsRoutes(app);

  // ── Static SPA serving ────────────────────────────────────────────────────
  const staticDir = resolveStaticDir();
  if (staticDir) {
    await app.register(fastifyStatic, {
      root: staticDir,
      prefix: '/',
      decorateReply: false,
    });
    // Fallback to index.html for SPA routes.
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) {
        reply.code(404).send({ error: 'not found' });
        return;
      }
      reply.type('text/html').sendFile('index.html');
    });
  } else {
    app.get('/', async (_req, reply) => {
      reply.type('text/html');
      return `<!doctype html><html><body>
        <h1>coffeectx UI server</h1>
        <p>The static web bundle is missing. Build the <code>webui</code> workspace:</p>
        <pre>npm run build --workspace=@coffeectx/webui</pre>
        <p>Then re-run <code>coffeectx-ui</code>.</p>
      </body></html>`;
    });
  }

  app.addHook('onClose', async () => closeAll());

  await app.listen({ host: opts.host, port: opts.port });
  console.log(`[ui] listening on http://${opts.host}:${opts.port}`);

  const shutdown = async (sig: string) => {
    console.log(`\n[ui] received ${sig}, shutting down`);
    try { await app.close(); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

/**
 * The compiled static bundle ships next to the indexer dist (`webui-dist/`)
 * when installed via npm, and at `webui/dist/` in the repo during development.
 */
function resolveStaticDir(): string | null {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  // 1. Bundled-next-to-dist layout (npm install ships dist/ + webui-dist/).
  const bundled = pathResolve(__dirname, '../../webui-dist');
  if (existsSync(join(bundled, 'index.html'))) return bundled;
  // 2. Monorepo dev layout: indexer/dist/ui/ → ../../webui/dist
  const monorepo = pathResolve(__dirname, '../../../webui/dist');
  if (existsSync(join(monorepo, 'index.html'))) return monorepo;
  return null;
}
