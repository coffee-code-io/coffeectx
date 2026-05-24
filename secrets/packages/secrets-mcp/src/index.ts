#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { execElevated } from '@coffeectx/secrets-core';

const server = new McpServer({ name: 'coffeectx-secrets', version: '0.1.0' });

server.tool(
  'exec_elevated',
  'Execute a bash command with configured secrets injected as environment variables after whitelist validation.',
  {
    command: z.string().min(1).describe('Bash command to execute via /bin/bash -lc'),
    secrets: z.array(z.string()).default([]).describe('Configured secret names to expose as same-named env vars'),
    env: z.record(z.string()).optional().describe('Additional non-secret env vars, restricted by whitelist allowed_env'),
    cwd: z.string().optional().describe('Working directory used for project resolution and command execution'),
    project: z.string().optional().describe('Explicit secrets project name'),
  },
  async (params) => {
    try {
      const result = await execElevated({
        command: params.command,
        secrets: params.secrets,
        env: params.env,
        cwd: params.cwd,
        project: params.project,
      });
      return {
        isError: !result.ok,
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
