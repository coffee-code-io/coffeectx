import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Db } from '@coffeectx/core';
import { resolveSymbols } from '@coffeectx/tools';

export function registerResolveSymbolsTool(server: McpServer, db: Db): void {
  server.tool(
    'resolve_symbols',
    resolveSymbols.description,
    {
      names: z.array(z.string()).min(1).describe('Symbol values to look up — typically function/class/file names extracted from text'),
      typeNames: z.array(z.string()).optional().describe('If set, only return candidates whose typeName is in this list (e.g. ["LspFunction","LspMethod"])'),
    },
    ({ names, typeNames }) => {
      const result = resolveSymbols.run(db, { names, typeNames });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );
}
