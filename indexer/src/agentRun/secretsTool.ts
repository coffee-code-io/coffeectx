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

import { loadConfig } from '@coffeectx/core';
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
