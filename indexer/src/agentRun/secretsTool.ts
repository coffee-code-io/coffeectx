/**
 * Optional `exec_elevated` injector for in-process agents.
 *
 * The global flag `secrets.loadIntoAgents` (in `~/.coffeecode/config.yaml`)
 * gates whether `@coffeectx/secrets-pi`'s `exec_elevated` tool is added
 * to every in-process pi session we build (UI agent, indexing agents,
 * user job agents). Whether the agent then actually CAN call the tool is
 * a separate question:
 *
 *   - UI agent / indexing agents: they don't have an `allowed-tools`
 *     concept; they advertise `tools: [...]` explicitly, so we add
 *     `exec_elevated` to both `customTools` AND the toolNames allowlist
 *     when the flag is on.
 *   - User job agents: the resolver in `toolPolicy.ts` only forwards
 *     `allowed-tools` entries. A skill must include `exec_elevated`
 *     (literally or via a glob) for it to be exposed.
 */

import { loadConfig, resolveSecretsProjectName } from '@coffeectx/core';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { buildExecElevatedTool } from '@coffeectx/secrets-pi';

/** True iff `secrets.loadIntoAgents` is on in the global config. */
export function secretsEnabled(): boolean {
  try { return !!loadConfig().secrets?.loadIntoAgents; }
  catch { return false; }
}

/**
 * Return `[execElevatedTool]` when the global flag is enabled; `[]`
 * otherwise. Callers spread the result into their `customTools` list.
 */
export function maybeExecElevatedTool(): ToolDefinition[] {
  if (!secretsEnabled()) return [];
  return [buildExecElevatedTool() as unknown as ToolDefinition];
}

/**
 * Set `process.env.COFFEECTX_SECRETS_PROJECT` so the in-process
 * `exec_elevated` tool resolves to this coffeectx project's secrets project
 * (per `ProjectEntry.secretsProject`, defaulting to the project name).
 * Pi sessions are in-process, so we mutate the host env once at session boot;
 * the secrets-core resolver reads `process.env` at every call. Concurrent
 * sessions for different projects would race — accepted for now since the UI
 * agent runs one session per project at a time.
 */
export function setSecretsProjectEnv(projectName: string): void {
  if (!secretsEnabled()) return;
  try {
    const cfg = loadConfig();
    process.env['COFFEECTX_SECRETS_PROJECT'] = resolveSecretsProjectName(cfg, projectName);
  } catch { /* config unreadable — leave env alone */ }
}
