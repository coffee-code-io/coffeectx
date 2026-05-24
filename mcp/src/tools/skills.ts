import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Skill } from '@coffeectx/core';
import { skills } from '@coffeectx/tools';

/**
 * Wire the MCP `list_skills` / `get_skill` tools against the in-memory
 * skill registry (loaded once at server startup from
 * `~/.coffeecode/skills/`). MCP callers — Claude Desktop, editor
 * integrations — see every loaded skill regardless of `loadInto`, since
 * they don't carry an agent identity.
 */
export function registerSkillsTools(server: McpServer, registry: ReadonlyArray<Skill>): void {
  server.tool(
    'list_skills',
    skills.listDescription,
    {},
    () => ({
      content: [{ type: 'text', text: JSON.stringify(skills.runList(registry, 'mcp'), null, 2) }],
    }),
  );

  server.tool(
    'get_skill',
    skills.getDescription,
    { name: z.string().describe('Skill name (= the directory under ~/.coffeecode/skills/).') },
    ({ name }) => {
      const result = skills.runGet(registry, 'mcp', { name });
      if (!result) {
        return {
          content: [{ type: 'text', text: `Skill "${name}" not found. Use list_skills to see available skills.` }],
          isError: true,
        };
      }
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );
}
