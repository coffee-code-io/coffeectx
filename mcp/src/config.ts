/**
 * MCP server config — resolves which project to serve based on the agent's
 * working directory, then materializes the project-scoped settings.
 */

import {
  loadConfig as loadUnifiedConfig,
  resolveProjectByCwd,
  resolveProjectEmbed,
  resolveProjectTools,
  listEnabledProjects,
} from '@coffeectx/core';
import type { CoffeectxConfig, EmbedSettings, ToolsSettings } from '@coffeectx/core';

export interface ResolvedConfig {
  config: CoffeectxConfig;
  projectName: string;
  dbPath: string;
  embed: EmbedSettings;
  tools: ToolsSettings;
}

/**
 * Resolve which project to serve from the current working directory.
 *
 * Resolution order:
 *   1. COFFEECTX_PROJECT env var (escape hatch / explicit override)
 *   2. Longest repoPath prefix match against process.cwd()
 *   3. cfg.active (if it's still enabled)
 *   4. The first enabled project
 *
 * Throws if no project can be resolved.
 */
export function loadConfig(): ResolvedConfig {
  const config = loadUnifiedConfig();
  const enabled = listEnabledProjects(config);
  if (enabled.length === 0) {
    throw new Error('No enabled projects in config. Run `coffeectx init`.');
  }

  const envName = process.env['COFFEECTX_PROJECT'];
  let projectName: string | null = null;

  if (envName && config.projects[envName]) {
    projectName = envName;
  } else {
    projectName = resolveProjectByCwd(config, process.cwd());
    if (!projectName && config.active && enabled.includes(config.active)) {
      projectName = config.active;
    }
    if (!projectName) projectName = enabled[0]!;
  }

  const project = config.projects[projectName];
  if (!project) throw new Error(`Project "${projectName}" not in config`);

  return {
    config,
    projectName,
    dbPath: project.db,
    embed: resolveProjectEmbed(config, projectName),
    tools: resolveProjectTools(config, projectName),
  };
}
