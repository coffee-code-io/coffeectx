#!/usr/bin/env node
/**
 * coffeectx-ui — local web UI server.
 *
 * Usage:
 *   coffeectx-ui                  # 127.0.0.1:7842
 *   coffeectx-ui --port 8080
 *   coffeectx-ui --host 0.0.0.0
 */

import { startServer } from './server.js';

const args = process.argv.slice(2);

function flag(name: string): string | undefined {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
}

const port = parseInt(flag('--port') ?? process.env['COFFEECTX_UI_PORT'] ?? '7842', 10);
const host = flag('--host') ?? process.env['COFFEECTX_UI_HOST'] ?? '127.0.0.1';

if (args.includes('--help') || args.includes('-h')) {
  console.log(`coffeectx-ui — local web UI for the coffeectx knowledge graph

Usage:
  coffeectx-ui [--host <ip>] [--port <n>]

Defaults:
  --host 127.0.0.1
  --port 7842

Open http://<host>:<port> in a browser.`);
  process.exit(0);
}

try {
  await startServer({ host, port });
} catch (err) {
  console.error(`[ui] failed to start: ${(err as Error).message}`);
  process.exit(1);
}
