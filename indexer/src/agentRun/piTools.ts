/**
 * Pi adapter for the shared @coffeectx/tools bodies.
 *
 * Mirrors mcp/src/tools/*.ts but uses pi's `defineTool` + TypeBox instead of
 * the MCP server's Zod-based registration. Tool execution runs in-process —
 * the Db handle is captured at build time and lives for the session.
 */

import { writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type, type Static } from 'typebox';
import type { Db } from '@coffeectx/core';
import {
  search,
  exact,
  regex,
  rawQuery,
  loadNode,
  upsertEntries,
  resolveSymbols,
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

const ResolveSymbolsParams = Type.Object({
  names: Type.Array(Type.String(), { minItems: 1, description: 'Symbol values to look up — typically function/class/file names extracted from text.' }),
  typeNames: Type.Optional(Type.Array(Type.String(), { description: 'If set, only return candidates whose typeName is in this list (e.g. ["LspFunction","LspMethod"]).' })),
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

const NavigateToNodeParams = Type.Object({
  nodeId: Type.String({ description: 'UUID of the node to open in the UI.' }),
  reason: Type.Optional(Type.String({ description: 'Short rationale shown next to the navigation event (e.g. "this is the function the user asked about").' })),
});

const WriteFileParams = Type.Object({
  path: Type.String({
    description:
      'Absolute path of the file to write. Relative paths are rejected — pass a fully-qualified path, ' +
      'composing from an env-var like $OBSIDIAN_VAULT/Daily/2026-05-24.md if your skill exposes one.',
  }),
  content: Type.String({ description: 'Full file body to write or append.' }),
  mode: Type.Optional(Type.Union([Type.Literal('overwrite'), Type.Literal('append')], {
    description: '`overwrite` (default) replaces the file; `append` adds to the end (creates the file if absent).',
    default: 'overwrite',
  })),
  createParents: Type.Optional(Type.Boolean({
    description: 'If true, create missing parent directories (mkdir -p). Default true.',
    default: true,
  })),
});

/**
 * Build a `navigate_to_node` tool that, when called by the agent, fires a
 * side-effect via `onNavigate` so the UI can switch focus to the node. The
 * tool returns a small confirmation payload to the agent.
 */
export function buildNavigateTool(onNavigate: (nodeId: string, reason?: string) => void) {
  return defineTool({
    name: 'navigate_to_node',
    label: 'Navigate UI to node',
    description:
      'Open the given graph node in the right-hand detail pane of the UI. ' +
      'Use this to direct the user\'s attention to a specific node after locating it. ' +
      'Only call when you are confident the node is what the user is asking about.',
    parameters: NavigateToNodeParams,
    execute: async (_id, raw: Static<typeof NavigateToNodeParams>) => {
      try {
        onNavigate(raw.nodeId, raw.reason);
        return textResult({ ok: true, nodeId: raw.nodeId });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  });
}

/**
 * Build a `write_file` tool that writes a single file to disk.
 *
 * Only enabled for indexer-side skill jobs (not the UI agent) — file write
 * is a meaningful trust boundary, so it's opt-in via `allowFileWrite` on
 * `buildGraphTools`. Skills declare any directory roots they need via env
 * vars (e.g. `coffeecode.requiredEnv: [OBSIDIAN_VAULT]`); the scheduler
 * exports those into `process.env` for the job's duration, so this tool
 * sees them via standard env-var expansion inside the path the agent
 * supplies.
 *
 * Safety: paths must be absolute. We don't sandbox the writes — the agent
 * is trusted code installed by the user under `~/.coffeecode/skills/`.
 */
export function buildWriteFileTool() {
  return defineTool({
    name: 'write_file',
    label: 'Write file',
    description:
      'Write or append text to an absolute file path on disk. Required for skills that produce ' +
      'output files (e.g. an Obsidian worklog under $OBSIDIAN_VAULT). Pass an absolute path — env ' +
      'vars exposed to the job (via coffeecode.requiredEnv) are available in process.env if you ' +
      'compose the path yourself.',
    parameters: WriteFileParams,
    execute: async (_id, raw: Static<typeof WriteFileParams>) => {
      try {
        const path = raw.path;
        if (!isAbsolute(path)) return errorResult(`path must be absolute (got "${path}")`);

        const mode = raw.mode ?? 'overwrite';
        const createParents = raw.createParents ?? true;
        if (createParents) {
          mkdirSync(dirname(path), { recursive: true });
        }
        if (mode === 'append') {
          appendFileSync(path, raw.content, 'utf-8');
        } else {
          writeFileSync(path, raw.content, 'utf-8');
        }
        return textResult({ ok: true, path, mode, bytes: Buffer.byteLength(raw.content, 'utf-8') });
      } catch (err) {
        return errorResult((err as Error).message);
      }
    },
  });
}

// ── Build the tool list (closing db over each tool's execute()) ─────────────

export interface BuildGraphToolsOptions {
  /** Expose `upsert_entries` for writing nodes back into the graph. */
  allowInsert?: boolean;
  /**
   * Expose `write_file` for writing arbitrary files to disk. Default
   * `false`. The UI agent runs at lower trust and should never get
   * filesystem write access; skill jobs (trusted code installed by the
   * user under `~/.coffeecode/jobs/`) flip this on.
   */
  allowFileWrite?: boolean;
}

/**
 * Build the agent's graph + utility tool list.
 *
 *  - `db` is the SQLite connection every tool closes over.
 *  - `allowInsert` gates `upsert_entries`.
 *  - `allowFileWrite` gates `write_file`.
 *
 * Skill discovery is **not** wired here — pi-coding-agent's native
 * ResourceLoader handles SKILL.md surfacing (system-prompt injection +
 * `/skill:<name>` slash commands). Wire skills via `createAgentSession`
 * by passing a configured `resourceLoader`, not via this function.
 */
export function buildGraphTools(db: Db, options: BuildGraphToolsOptions = {}) {
  const allowInsert = options.allowInsert ?? false;
  const allowFileWrite = options.allowFileWrite ?? false;
  // Widen the array type — tools we push conditionally (upsert_entries,
  // write_file) have different parameter shapes than the initial entries.
  const tools: ReturnType<typeof defineTool>[] = [
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
      name: 'resolve_symbols',
      label: 'Resolve symbol names',
      description: resolveSymbols.description,
      parameters: ResolveSymbolsParams,
      execute: async (_id, raw: Static<typeof ResolveSymbolsParams>) => {
        try {
          const result = resolveSymbols.run(db, { names: raw.names, typeNames: raw.typeNames });
          return textResult(result);
        } catch (err) {
          return errorResult((err as Error).message);
        }
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

  if (allowFileWrite) {
    tools.push(buildWriteFileTool());
  }

  return tools;
}

export const GRAPH_TOOL_NAMES = [
  'search',
  'get_by_symbol_text',
  'regex',
  'raw_query',
  'get_node_by_id',
  'resolve_symbols',
  'upsert_entries',
  'write_file',
] as const;
