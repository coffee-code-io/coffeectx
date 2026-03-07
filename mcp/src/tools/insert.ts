import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Db, Node } from '@retrival-mcp/core';

// Annotated as ZodType<unknown> to break the circular lazy reference;
// type field is opaque JSON validated at the DB layer. Cast to Node at usage.
const NodeSchema: z.ZodType<unknown> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('atom'),
      atom: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('symbol'), value: z.string() }),
        z.object({
          kind: z.literal('meaning'),
          value: z.object({
            text: z.string(),
            // vec is optional — will be computed by the embed function if absent
            vec: z
              .array(z.number())
              .length(128)
              .optional()
              .transform(v => (v ? new Float32Array(v) : new Float32Array(128))),
          }),
        }),
      ]),
    }),
    z.object({ kind: z.literal('list'), items: z.array(NodeSchema) }),
    z.object({
      kind: z.literal('map'),
      entries: z.record(NodeSchema),
      type: z.any(), // Type is complex; validated loosely here
    }),
  ]),
);

export function registerInsertTool(server: McpServer, db: Db): void {
  server.tool(
    'insert',
    'Insert a node into the knowledge graph. The node must conform to the Node schema (atom | list | map). Meanings without a vec will have their embedding computed automatically.',
    {
      node: z
        .string()
        .describe('JSON-encoded Node value. See schema: { kind: "atom"|"list"|"map", ... }'),
    },
    async ({ node: nodeJson }) => {
      let raw: unknown;
      try {
        raw = JSON.parse(nodeJson);
      } catch {
        return {
          content: [{ type: 'text', text: 'Invalid JSON' }],
          isError: true,
        };
      }

      const parsed = NodeSchema.safeParse(raw);
      if (!parsed.success) {
        return {
          content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }],
          isError: true,
        };
      }

      const id = await db.insertNode(parsed.data as Node);
      return {
        content: [{ type: 'text', text: JSON.stringify({ id }) }],
      };
    },
  );
}
