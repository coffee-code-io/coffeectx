/**
 * GET /api/debug — return the global debug flag from the user's
 * `~/.coffeecode/config.yaml`.
 *
 * The webui fetches this once on app bootstrap and stashes the result
 * in zustand; every debug-only render path then reads the value
 * synchronously without round-tripping. Keeps the URL/JSON contract
 * tiny because we don't expect this to grow beyond one boolean for the
 * foreseeable future.
 */

import type { FastifyInstance } from 'fastify';
import { loadConfig } from '@coffeectx/core';

export async function registerDebugRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/debug', async () => {
    let debug = false;
    try { debug = !!loadConfig().debug; }
    catch { /* missing / malformed config → debug off */ }
    return { debug };
  });
}
