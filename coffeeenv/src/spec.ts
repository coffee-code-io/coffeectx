import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";

const ToolSchema = z.object({
  name: z.string(),
  source: z.enum(["npm", "system"]),
  package: z.string().optional(),
  version: z.string().optional(),
  hijack: z.enum(["home", "none"]).default("none"),
});

const BinSchema = z.object({
  name: z.string(),
  source: z.enum(["system", "npm"]).default("system"),
  package: z.string().optional(),
});

const ClaudeSchema = z
  .object({
    agents_md: z.string().optional(),
    settings: z.string().optional(),
    mcp_servers: z.string().optional(),
    hooks_dir: z.string().optional(),
  })
  .default({});

export const SpecSchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9_-]+$/, "name must be slug-safe"),
  description: z.string().optional(),
  tools: z.array(ToolSchema).default([]),
  bins: z.array(BinSchema).default([]),
  claude: ClaudeSchema,
  env: z.record(z.string()).default({}),
});

export type Spec = z.infer<typeof SpecSchema>;
export type Tool = z.infer<typeof ToolSchema>;
export type Bin = z.infer<typeof BinSchema>;

export interface LoadedSpec {
  spec: Spec;
  dir: string;
}

export function loadSpec(profileDir: string): LoadedSpec {
  const yamlPath = path.join(profileDir, "coffeeenv.yaml");
  if (!fs.existsSync(yamlPath)) {
    throw new Error(`No coffeeenv.yaml in ${profileDir}`);
  }
  const raw = fs.readFileSync(yamlPath, "utf8");
  const parsed = YAML.parse(raw);
  const spec = SpecSchema.parse(parsed);
  return { spec, dir: profileDir };
}
