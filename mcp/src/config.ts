/**
 * MCP server config — thin wrapper around the unified coffeectx config.
 * Reads ~/.coffeecode/config.yaml via @coffeectx/core.
 */

import { loadConfig as loadUnifiedConfig, resolveDbPath } from '@coffeectx/core';
import type { CoffeectxConfig } from '@coffeectx/core';

export type { CoffeectxConfig as Config };

export function loadConfig(): CoffeectxConfig & { dbPath: string } {
  const cfg = loadUnifiedConfig();

  // Resolve db path — env override takes priority, then active project, then legacy
  const envDbPath = process.env['COFFEECTX_DB_PATH'] ?? process.env['RETRIVAL_DB_PATH'];
  const dbPath = envDbPath ?? resolveDbPath(cfg);

  // Legacy env-var compat
  const envInsert = process.env['RETRIVAL_INSERT'];
  if (envInsert === '1' || envInsert === 'true') cfg.tools.insert = true;

  return { ...cfg, dbPath };
}
