import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Db } from '@retrival-mcp/core';

export function registerSkillsTools(server: McpServer, db: Db): void {
  // ── list_skills ─────────────────────────────────────────────────────────────

  server.tool(
    'list_skills',
    'List all indexing skills available in the knowledge graph. Each skill has a name, description, and the set of types it uses.',
    {},
    () => {
      const skills = db.listSkills();
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              skills.map(s => ({
                name: s.name,
                description: s.description,
                source: s.source,
                types: s.types,
              })),
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // ── get_skill ───────────────────────────────────────────────────────────────

  server.tool(
    'get_skill',
    'Get a specific indexing skill by name, including its full prompt and the list of types it uses.',
    {
      name: z.string().describe('Skill name, e.g. "CodeStructureIndexing"'),
    },
    ({ name }) => {
      const skill = db.getSkill(name);
      if (!skill) {
        return {
          content: [{ type: 'text', text: `Skill "${name}" not found. Use list_skills to see available skills.` }],
          isError: true,
        };
      }

      // Also fetch type descriptions for context
      const typeInfo = skill.types.map(typeName => {
        const entry = db.loadNamedType(typeName);
        return { name: typeName, description: entry?.description ?? null };
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ ...skill, typeDetails: typeInfo }, null, 2),
          },
        ],
      };
    },
  );
}
