#!/usr/bin/env node
/**
 * Post-tsc bundle step.
 *
 * 1. Bundles dist/agentRun/runSkill.js (tsc output) with @qwen-code/sdk inlined
 *    using esbuild. The file is overwritten in-place so all other relative imports
 *    from tsc-compiled files remain valid.
 *
 * 2. Copies the patched qwen-code CLI to dist/vendor/qwen-cli.js.
 */

import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const indexerRoot = resolve(__dirname, '..');

// ── 1. Bundle runSkill.js ──────────────────────────────────────────────────

console.log('[bundle] Bundling agentRun/runSkill.ts with @qwen-code/sdk…');

await build({
  entryPoints: [resolve(indexerRoot, 'src/agentRun/runSkill.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: resolve(indexerRoot, 'dist/agentRun/runSkill.js'),
  allowOverwrite: true,
  // Preserve import.meta.url so __dirname derivation keeps working
  define: {},
  // Keep everything external except the qwen SDK (which we want inlined)
  external: [
    'node:*',
    '@coffeectx/core',
    '@coffeectx/server',
    'vscode-jsonrpc',
    'vscode-languageserver-protocol',
    'yaml',
    // native modules that can't be bundled
    'better-sqlite3',
    'sqlite-vec',
  ],
  // Suppress "use of eval" and similar warnings from the SDK internals
  logLevel: 'warning',
});

console.log('[bundle] runSkill.js bundled.');

// ── 2. Vendor the patched qwen CLI ────────────────────────────────────────

const vendorDir = resolve(indexerRoot, 'dist/vendor');
await mkdir(vendorDir, { recursive: true });

// In the monorepo the CLI lives at qwen-code/dist/cli.js (sibling of indexer/).
const monorepoCliPath = resolve(indexerRoot, '../qwen-code/dist/cli.js');

if (!existsSync(monorepoCliPath)) {
  console.warn(`[bundle] WARNING: qwen CLI not found at ${monorepoCliPath}. Skipping vendor copy.`);
  console.warn('[bundle] Published package will fall back to SDK auto-discovery for the CLI.');
} else {
  const destPath = join(vendorDir, 'qwen-cli.js');
  await copyFile(monorepoCliPath, destPath);
  const sizeMb = (await import('node:fs')).statSync(destPath).size / 1024 / 1024;
  console.log(`[bundle] Vendored qwen CLI → dist/vendor/qwen-cli.js (${sizeMb.toFixed(1)} MB)`);
}

console.log('[bundle] Done.');
