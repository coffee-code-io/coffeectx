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
import { registerAgentRoutes } from './routes/agent.js';
import { closeAll } from './dbPool.js';
import { disposeAll as disposeAllAgents } from './agentSessions.js';

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
  await registerAgentRoutes(app);

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

  app.addHook('onClose', async () => {
    // Abort any in-flight pi sessions before yanking the DB handles, so
    // late writes from a provider response don't error against a closed db.
    await disposeAllAgents();
    closeAll();
  });

  await app.listen({ host: opts.host, port: opts.port });
  console.log(`[ui] listening on http://${opts.host}:${opts.port}`);

  // Same pattern as the scheduler: first signal kicks off a graceful close
  // under a hard deadline, second signal force-exits. Without the watchdog,
  // pi-coding-agent's in-flight LLM request can keep the event loop alive
  // for the full provider timeout (often 60s+) after the user hit Ctrl-C.
  const SHUTDOWN_DEADLINE_MS = 10_000;
  let stopping = false;
  const shutdown = (sig: string) => {
    if (stopping) {
      console.log(`[ui] second ${sig} — force exit`);
      process.exit(1);
    }
    stopping = true;
    console.log(`\n[ui] received ${sig}, shutting down`);
    const hardKill = setTimeout(() => {
      console.error('[ui] shutdown timeout — force exit');
      process.exit(1);
    }, SHUTDOWN_DEADLINE_MS);
    hardKill.unref();
    void (async () => {
      try { await app.close(); } catch { /* ignore */ }
      clearTimeout(hardKill);
      process.exit(0);
    })();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
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
