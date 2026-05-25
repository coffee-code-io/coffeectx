import { Type, type Static } from 'typebox';
import { execElevated } from '@coffeectx/secrets-core';

interface ToolExecuteResult {
  content: Array<{ type: 'text'; text: string }>;
  details: Record<string, unknown>;
  isError?: boolean;
}

interface MinimalExtensionAPI {
  registerTool(definition: {
    name: string;
    label: string;
    description: string;
    promptSnippet?: string;
    promptGuidelines?: string[];
    parameters: unknown;
    execute: (
      toolCallId: string,
      params: unknown,
      signal?: AbortSignal,
      onUpdate?: unknown,
      ctx?: MinimalExtensionContext,
    ) => Promise<ToolExecuteResult>;
  }): void;
}

interface MinimalExtensionContext {
  hasUI?: boolean;
  ui?: {
    confirm?: (title: string, message?: string) => Promise<boolean>;
    select?: (message: string, choices: string[]) => Promise<string | undefined>;
  };
}

const ExecElevatedParams = Type.Object({
  command: Type.String({ description: 'Bash command to execute via /bin/bash -lc' }),
  secrets: Type.Optional(Type.Array(Type.String(), { description: 'Configured secret names to expose as same-named env vars' })),
  env: Type.Optional(Type.Record(Type.String(), Type.String(), { description: 'Additional non-secret env vars allowed by whitelist' })),
  cwd: Type.Optional(Type.String({ description: 'Working directory used for project resolution and command execution' })),
  project: Type.Optional(Type.String({ description: 'Explicit secrets project name' })),
});

function textResult(value: unknown, isError = false): ToolExecuteResult {
  return {
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
    details: typeof value === 'object' && value !== null ? { result: value } : {},
    isError,
  };
}

async function confirmUnmatched(command: string, ctx?: MinimalExtensionContext): Promise<boolean> {
  if (!ctx?.hasUI) return false;
  if (ctx.ui?.confirm) {
    return ctx.ui.confirm('Allow unmatched secrets command?', command);
  }
  if (ctx.ui?.select) {
    const choice = await ctx.ui.select(`Allow unmatched secrets command?\n\n${command}`, ['Yes', 'No']);
    return choice === 'Yes';
  }
  return false;
}

/**
 * Build the `exec_elevated` tool definition without registering it on a
 * pi extension API. Returned object is shaped exactly like the pi
 * `ToolDefinition` interface, so in-process coffeectx agents can wire it
 * into `customTools` directly (no extension loader needed).
 *
 * Use the default export for the classic pi extension flow (drop a 3-
 * liner into `~/.pi/agent/extensions/`); use this when you're driving
 * `createAgentSession({ customTools: [...] })` yourself.
 */
export function buildExecElevatedTool(): {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: unknown;
  execute: (
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: MinimalExtensionContext,
  ) => Promise<ToolExecuteResult>;
} {
  return {
    name: 'exec_elevated',
    label: 'Execute with secrets',
    description: 'Execute a bash command with configured secrets injected after whitelist validation.',
    promptSnippet: 'Execute whitelisted bash commands with project secrets exposed as environment variables',
    promptGuidelines: [
      'Use exec_elevated only when a command requires configured secrets; use normal bash for commands that do not need secrets.',
      'Pass only the minimum required secret names to exec_elevated.',
    ],
    parameters: ExecElevatedParams,
    execute: async (_toolCallId, raw, _signal, _onUpdate, ctx) => {
      const params = raw as Static<typeof ExecElevatedParams>;
      try {
        let result = await execElevated({
          command: params.command,
          secrets: params.secrets ?? [],
          env: params.env,
          cwd: params.cwd,
          project: params.project,
        });

        if (!result.ok && result.warning === 'Command did not match any whitelist rule') {
          const approved = await confirmUnmatched(params.command, ctx);
          if (!approved) return textResult(result, true);
          result = await execElevated(
            {
              command: params.command,
              secrets: params.secrets ?? [],
              env: params.env,
              cwd: params.cwd,
              project: params.project,
            },
            { approveUnmatched: true },
          );
        }

        return textResult(result, !result.ok);
      } catch (err) {
        return textResult(`Error: ${(err as Error).message}`, true);
      }
    },
  };
}

export default function secretsPiExtension(pi: MinimalExtensionAPI): void {
  pi.registerTool(buildExecElevatedTool());
}
