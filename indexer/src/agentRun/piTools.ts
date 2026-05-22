/**
 * Pi adapter for the shared @coffeectx/tools bodies.
 *
 * Mirrors mcp/src/tools/*.ts but uses pi's `defineTool` + TypeBox instead of
 * the MCP server's Zod-based registration. Tool execution runs in-process —
 * the Db handle is captured at build time and lives for the session.
 */

import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type, type Static } from 'typebox';
import type { Db } from '@coffeectx/core';
import {
  search,
  exact,
  regex,
  rawQuery,
  loadNode,
  skills,
  upsertEntries,
} from '@coffeectx/tools';

/** Tool name → wraps a JSON-serialised body inside the pi content payload. */
function textResult(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    details: {},
  };
}

function errorResult(message: string) {
  return {
    content: [{ type: 'text' as const, text: `Error: ${message}` }],
    details: {},
    isError: true,
  };
}

// ── Schemas ───────────────────────────────────────────────────────────────────

const SearchParams = Type.Object({
  query: Type.String({ description: 'Natural-language description of the knowledge you are looking for' }),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 10 })),
  offset: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
  includeHidden: Type.Optional(Type.Boolean({ default: false })),
});

const ExactParams = Type.Object({
  value: Type.String({ description: 'Exact symbol text to look up' }),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, default: 50 })),
  offset: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
  includeHidden: Type.Optional(Type.Boolean({ default: false })),
});

const RegexParams = Type.Object({
  pattern: Type.String({ description: 'JavaScript RegExp pattern (case-insensitive)' }),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, default: 50 })),
  offset: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
  includeHidden: Type.Optional(Type.Boolean({ default: false })),
});

const RawQueryParams = Type.Object({
  query: Type.String({ description: 'Query expression in the retrival query language' }),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, default: 50 })),
  offset: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
  depth: Type.Optional(Type.Integer({ minimum: 0, maximum: 20, default: 10 })),
  verbose: Type.Optional(Type.Boolean({ default: false })),
  includeHidden: Type.Optional(Type.Boolean({ default: false })),
});

const LoadNodeParams = Type.Object({
  id: Type.String({ description: 'Node UUID to load' }),
  depth: Type.Optional(Type.Integer({ minimum: 0, maximum: 20, default: 10 })),
  verbose: Type.Optional(Type.Boolean({ default: false })),
});

const ListSkillsParams = Type.Object({});

const GetSkillParams = Type.Object({
  name: Type.String({ description: 'Skill name, e.g. "ArchitecturalDecisionIndexing"' }),
});

const UpsertEntriesParams = Type.Object({
  entries: Type.Array(
    Type.Object({
      $type: Type.String(),
      $id: Type.Optional(Type.String()),
    }, { additionalProperties: true }),
    { minItems: 1, description: 'Array of entries. "$type" is required.' },
  ),
});

// ── Build the tool list (closing db over each tool's execute()) ─────────────

export function buildGraphTools(db: Db, allowInsert: boolean) {
  const tools = [
    defineTool({
      name: 'search',
      label: 'Search knowledge graph',
      description: search.description,
      parameters: SearchParams,
      execute: async (_id, raw: Static<typeof SearchParams>) => {
        try {
          const result = await search.run(db, {
            query: raw.query,
            limit: raw.limit ?? 10,
            offset: raw.offset ?? 0,
            includeHidden: raw.includeHidden ?? false,
          });
          return textResult(result);
        } catch (err) {
          return errorResult((err as Error).message);
        }
      },
    }),

    defineTool({
      name: 'get_by_symbol_text',
      label: 'Exact symbol lookup',
      description: exact.description,
      parameters: ExactParams,
      execute: async (_id, raw: Static<typeof ExactParams>) => {
        try {
          const result = exact.run(db, {
            value: raw.value,
            limit: raw.limit ?? 50,
            offset: raw.offset ?? 0,
            includeHidden: raw.includeHidden ?? false,
          });
          return textResult(result);
        } catch (err) {
          return errorResult((err as Error).message);
        }
      },
    }),

    defineTool({
      name: 'regex',
      label: 'Regex symbol match',
      description: regex.description,
      parameters: RegexParams,
      execute: async (_id, raw: Static<typeof RegexParams>) => {
        try {
          const result = regex.run(db, {
            pattern: raw.pattern,
            limit: raw.limit ?? 50,
            offset: raw.offset ?? 0,
            includeHidden: raw.includeHidden ?? false,
          });
          return textResult(result);
        } catch (err) {
          return errorResult((err as Error).message);
        }
      },
    }),

    defineTool({
      name: 'raw_query',
      label: 'Query language',
      description: rawQuery.description,
      parameters: RawQueryParams,
      execute: async (_id, raw: Static<typeof RawQueryParams>) => {
        try {
          const result = await rawQuery.run(db, {
            query: raw.query,
            limit: raw.limit ?? 50,
            offset: raw.offset ?? 0,
            depth: raw.depth ?? 10,
            verbose: raw.verbose ?? false,
            includeHidden: raw.includeHidden ?? false,
          });
          return textResult(result);
        } catch (err) {
          return errorResult(`${(err as Error).message}\n\nSyntax reference:\n${rawQuery.SYNTAX}`);
        }
      },
    }),

    defineTool({
      name: 'get_node_by_id',
      label: 'Load node by id',
      description: loadNode.description,
      parameters: LoadNodeParams,
      execute: async (_id, raw: Static<typeof LoadNodeParams>) => {
        try {
          const result = loadNode.run(db, {
            id: raw.id,
            depth: raw.depth ?? 10,
            verbose: raw.verbose ?? false,
          });
          return textResult(result);
        } catch (err) {
          return errorResult((err as Error).message);
        }
      },
    }),

    defineTool({
      name: 'list_skills',
      label: 'List skills',
      description: skills.listDescription,
      parameters: ListSkillsParams,
      execute: async () => textResult(skills.runList(db)),
    }),

    defineTool({
      name: 'get_skill',
      label: 'Get skill',
      description: skills.getDescription,
      parameters: GetSkillParams,
      execute: async (_id, raw: Static<typeof GetSkillParams>) => {
        const result = skills.runGet(db, { name: raw.name });
        if (!result) {
          return errorResult(`Skill "${raw.name}" not found. Use list_skills to see available skills.`);
        }
        return textResult(result);
      },
    }),
  ];

  if (allowInsert) {
    tools.push(
      defineTool({
        name: 'upsert_entries',
        label: 'Insert / patch entries',
        description: upsertEntries.description,
        parameters: UpsertEntriesParams,
        execute: async (_id, raw: Static<typeof UpsertEntriesParams>) => {
          try {
            const response = await upsertEntries.run(db, {
              entries: raw.entries as upsertEntries.InsertEntryDTO[],
            });
            if (response.parseErrors) {
              return errorResult(response.parseErrors.map(e => e.message).join('\n'));
            }
            return textResult(response.result);
          } catch (err) {
            return errorResult((err as Error).message);
          }
        },
      }),
    );
  }

  return tools;
}

export const GRAPH_TOOL_NAMES = [
  'search',
  'get_by_symbol_text',
  'regex',
  'raw_query',
  'get_node_by_id',
  'list_skills',
  'get_skill',
  'upsert_entries',
] as const;
