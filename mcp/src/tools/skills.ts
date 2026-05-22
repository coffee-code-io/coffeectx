import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Db } from '@coffeectx/core';
import { skills } from '@coffeectx/tools';

export function registerSkillsTools(server: McpServer, db: Db): void {
  server.tool(
    'list_skills',
    skills.listDescription,
    {},
    () => ({
      content: [{ type: 'text', text: JSON.stringify(skills.runList(db), null, 2) }],
    }),
  );

  server.tool(
    'get_skill',
    skills.getDescription,
    { name: z.string().describe('Skill name, e.g. "CodeStructureIndexing"') },
    ({ name }) => {
      const result = skills.runGet(db, { name });
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
