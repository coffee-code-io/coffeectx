/**
 * coffeectx pi-plugin
 * ===================
 *
 * Default-export an [ExtensionFactory] that registers the coffeectx
 * knowledge-graph tools with a running `@earendil-works/pi-coding-agent`
 * session. Drop a 3-line extension file into `~/.pi/agent/extensions/` that
 * re-exports the default from this package and pi will pick it up.
 *
 * Tool surface mirrors the MCP server and the in-process indexer adapter:
 *   - search, get_by_symbol_text, regex, raw_query, get_node_by_id
 *   - list_skills, get_skill
 *   - resolve_symbols
 *   - upsert_entries  (gated by config.mcp.tools.insert)
 *
 * Project resolution: at startup, the plugin reads `~/.coffeecode/config.yaml`
 * and picks the project whose `repoPath` contains the current working
 * directory (using `resolveProjectByCwd`, which already handles
 * `/tmp` ↔ `/private/tmp` realpath). If no project matches, the plugin logs a
 * one-liner and registers nothing — the extension is a no-op rather than a
 * crash.
 */

import { Type, type Static } from 'typebox';
import {
  Db,
  createEmbedFn,
  loadConfig,
  resolveProjectByCwd,
  resolveProjectEmbed,
  resolveProjectTools,
} from '@coffeectx/core';
import {
  search,
  exact,
  regex,
  rawQuery,
  loadNode,
  skills,
  upsertEntries,
  resolveSymbols,
} from '@coffeectx/tools';

// ── Pi types (kept minimal so we don't take a hard dep on the runtime) ───────
//
// We only need the shapes the extension factory touches. `registerTool` and
// `ExtensionAPI.on()` accept richer types from pi but `unknown` here keeps
// this package compilable without `@earendil-works/pi-coding-agent` declared
// as a build-time dep — it's a peer dep, so the user's pi runtime supplies
// the actual API at registration time.

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
    parameters: unknown;
    execute: (
      toolCallId: string,
      params: unknown,
      signal?: AbortSignal,
      onUpdate?: unknown,
      ctx?: unknown,
    ) => Promise<ToolExecuteResult>;
  }): void;
}

// ── Schemas (lifted from indexer/src/agentRun/piTools.ts) ────────────────────

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
  name: Type.String({ description: 'Skill name' }),
});

const ResolveSymbolsParams = Type.Object({
  names: Type.Array(Type.String(), { minItems: 1, description: 'Symbol values to resolve in batch.' }),
  typeNames: Type.Optional(Type.Array(Type.String(), { description: 'Restrict candidates to these typeNames.' })),
});

const UpsertEntriesParams = Type.Object({
  entries: Type.Array(
    Type.Object({ $type: Type.String(), $id: Type.Optional(Type.String()) }, { additionalProperties: true }),
    { minItems: 1, description: 'Array of entries. "$type" is required.' },
  ),
});

// ── Result helpers ──────────────────────────────────────────────────────────

function textResult(value: unknown): ToolExecuteResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], details: {} };
}
function errorResult(message: string): ToolExecuteResult {
  return { content: [{ type: 'text', text: `Error: ${message}` }], details: {}, isError: true };
}

// ── Extension factory ───────────────────────────────────────────────────────

/**
 * Pi.dev extension factory. Resolves the active project from the current
 * working directory, opens the project DB, and registers every graph tool.
 *
 * If no project matches `process.cwd()`, the extension is a silent no-op.
 */
const factory = (pi: MinimalExtensionAPI): void => {
  let cfg;
  try { cfg = loadConfig(); }
  catch (err) {
    console.warn(`[coffeectx-pi-plugin] config load failed: ${(err as Error).message} — no tools registered`);
    return;
  }

  const cwd = process.cwd();
  const projectName = resolveProjectByCwd(cfg, cwd);
  if (!projectName) {
    console.warn(`[coffeectx-pi-plugin] no project in ~/.coffeecode/config.yaml matches cwd "${cwd}" — no tools registered`);
    return;
  }
  const projectEntry = cfg.projects[projectName];
  if (!projectEntry) {
    console.warn(`[coffeectx-pi-plugin] resolved project "${projectName}" but config entry is missing — no tools registered`);
    return;
  }

  const embedCfg = resolveProjectEmbed(cfg, projectName);
  const toolsCfg = resolveProjectTools(cfg, projectName);
  const embed = createEmbedFn(embedCfg);
  const db = new Db({ path: projectEntry.db, embed, dimensions: embedCfg.dimensions });

  const allowInsert = toolsCfg.insert === true;

  // ── Registrations ────────────────────────────────────────────────────────

  pi.registerTool({
    name: 'search',
    label: 'Search knowledge graph',
    description: search.description,
    parameters: SearchParams,
    execute: async (_id, raw) => {
      const p = raw as Static<typeof SearchParams>;
      try {
        const result = await search.run(db, {
          query: p.query,
          limit: p.limit ?? 10,
          offset: p.offset ?? 0,
          includeHidden: p.includeHidden ?? false,
        });
        return textResult(result);
      } catch (err) { return errorResult((err as Error).message); }
    },
  });

  pi.registerTool({
    name: 'get_by_symbol_text',
    label: 'Exact symbol lookup',
    description: exact.description,
    parameters: ExactParams,
    execute: async (_id, raw) => {
      const p = raw as Static<typeof ExactParams>;
      try {
        const result = exact.run(db, {
          value: p.value,
          limit: p.limit ?? 50,
          offset: p.offset ?? 0,
          includeHidden: p.includeHidden ?? false,
        });
        return textResult(result);
      } catch (err) { return errorResult((err as Error).message); }
    },
  });

  pi.registerTool({
    name: 'regex',
    label: 'Regex symbol match',
    description: regex.description,
    parameters: RegexParams,
    execute: async (_id, raw) => {
      const p = raw as Static<typeof RegexParams>;
      try {
        const result = regex.run(db, {
          pattern: p.pattern,
          limit: p.limit ?? 50,
          offset: p.offset ?? 0,
          includeHidden: p.includeHidden ?? false,
        });
        return textResult(result);
      } catch (err) { return errorResult((err as Error).message); }
    },
  });

  pi.registerTool({
    name: 'raw_query',
    label: 'Query language',
    description: rawQuery.description,
    parameters: RawQueryParams,
    execute: async (_id, raw) => {
      const p = raw as Static<typeof RawQueryParams>;
      try {
        const result = await rawQuery.run(db, {
          query: p.query,
          limit: p.limit ?? 50,
          offset: p.offset ?? 0,
          depth: p.depth ?? 10,
          verbose: p.verbose ?? false,
          includeHidden: p.includeHidden ?? false,
        });
        return textResult(result);
      } catch (err) { return errorResult(`${(err as Error).message}\n\nSyntax reference:\n${rawQuery.SYNTAX}`); }
    },
  });

  pi.registerTool({
    name: 'get_node_by_id',
    label: 'Load node by id',
    description: loadNode.description,
    parameters: LoadNodeParams,
    execute: async (_id, raw) => {
      const p = raw as Static<typeof LoadNodeParams>;
      try {
        const result = loadNode.run(db, {
          id: p.id,
          depth: p.depth ?? 10,
          verbose: p.verbose ?? false,
        });
        return textResult(result);
      } catch (err) { return errorResult((err as Error).message); }
    },
  });

  pi.registerTool({
    name: 'list_skills',
    label: 'List skills',
    description: skills.listDescription,
    parameters: ListSkillsParams,
    execute: async () => textResult(skills.runList(db)),
  });

  pi.registerTool({
    name: 'get_skill',
    label: 'Get skill',
    description: skills.getDescription,
    parameters: GetSkillParams,
    execute: async (_id, raw) => {
      const p = raw as Static<typeof GetSkillParams>;
      const result = skills.runGet(db, { name: p.name });
      if (!result) return errorResult(`Skill "${p.name}" not found.`);
      return textResult(result);
    },
  });

  pi.registerTool({
    name: 'resolve_symbols',
    label: 'Resolve symbol names',
    description: resolveSymbols.description,
    parameters: ResolveSymbolsParams,
    execute: async (_id, raw) => {
      const p = raw as Static<typeof ResolveSymbolsParams>;
      try {
        const result = resolveSymbols.run(db, { names: p.names, typeNames: p.typeNames });
        return textResult(result);
      } catch (err) { return errorResult((err as Error).message); }
    },
  });

  if (allowInsert) {
    pi.registerTool({
      name: 'upsert_entries',
      label: 'Insert / patch entries',
      description: upsertEntries.description,
      parameters: UpsertEntriesParams,
      execute: async (_id, raw) => {
        const p = raw as Static<typeof UpsertEntriesParams>;
        try {
          const response = await upsertEntries.run(db, { entries: p.entries as upsertEntries.InsertEntryDTO[] });
          if (response.parseErrors) return errorResult(response.parseErrors.map(e => e.message).join('\n'));
          return textResult(response.result);
        } catch (err) { return errorResult((err as Error).message); }
      },
    });
  }

  console.log(
    `[coffeectx-pi-plugin] registered tools for project "${projectName}"` +
    `${allowInsert ? '' : ' (read-only — set mcp.tools.insert=true to enable upsert_entries)'}`,
  );
};

export default factory;
