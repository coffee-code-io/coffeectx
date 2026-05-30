import fs from "node:fs";
import path from "node:path";
import type { LoadedSpec } from "./spec.js";
import { layout } from "./paths.js";

export interface RenderContext {
  envVars: Record<string, string>;
}

export function renderClaude(
  loaded: LoadedSpec,
  envName: string,
  ctx: RenderContext,
  rootOverride?: string,
): void {
  const L = layout(rootOverride);
  const { spec, dir: profileDir } = loaded;
  const claudeDir = L.envClaudeDir(envName);
  fs.mkdirSync(claudeDir, { recursive: true });

  // CLAUDE.md
  if (spec.claude.agents_md) {
    const src = path.resolve(profileDir, spec.claude.agents_md);
    const content = substitute(fs.readFileSync(src, "utf8"), ctx.envVars);
    fs.writeFileSync(path.join(claudeDir, "CLAUDE.md"), content);
  }

  // settings.json
  if (spec.claude.settings) {
    const src = path.resolve(profileDir, spec.claude.settings);
    const content = substitute(fs.readFileSync(src, "utf8"), ctx.envVars);
    fs.writeFileSync(path.join(claudeDir, "settings.json"), content);
  }

  // hooks dir
  if (spec.claude.hooks_dir) {
    const src = path.resolve(profileDir, spec.claude.hooks_dir);
    if (fs.existsSync(src)) {
      const dst = path.join(claudeDir, "hooks");
      fs.mkdirSync(dst, { recursive: true });
      for (const f of fs.readdirSync(src)) {
        const sp = path.join(src, f);
        const dp = path.join(dst, f);
        const content = substitute(fs.readFileSync(sp, "utf8"), ctx.envVars);
        fs.writeFileSync(dp, content, { mode: 0o755 });
      }
    }
  }

  // .claude.json mcpServers
  const mcpServers: Record<string, unknown> = {};
  if (spec.claude.mcp_servers) {
    const matches = simpleGlob(profileDir, spec.claude.mcp_servers);
    for (const m of matches) {
      const name = path.basename(m, path.extname(m));
      const raw = substitute(fs.readFileSync(m, "utf8"), ctx.envVars);
      mcpServers[name] = JSON.parse(raw);
    }
  }

  // Claude Code reads ~/.claude.json with per-project + global mcpServers.
  // For a fresh fake-HOME the file may not exist; write a minimal scaffold.
  const claudeJsonPath = L.envClaudeJson(envName);
  let existing: Record<string, unknown> = {};
  if (fs.existsSync(claudeJsonPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(claudeJsonPath, "utf8"));
    } catch {}
  }
  existing.mcpServers = mcpServers;
  fs.writeFileSync(claudeJsonPath, JSON.stringify(existing, null, 2));
}

function simpleGlob(baseDir: string, pattern: string): string[] {
  // Supports `<dir>/<prefix>*<suffix>` (single wildcard in basename only).
  const abs = path.resolve(baseDir, pattern);
  const dir = path.dirname(abs);
  const base = path.basename(abs);
  if (!fs.existsSync(dir)) return [];
  if (!base.includes("*")) return fs.existsSync(abs) ? [abs] : [];
  const [prefix, suffix] = base.split("*", 2);
  return fs
    .readdirSync(dir)
    .filter((n) => n.startsWith(prefix) && n.endsWith(suffix))
    .map((n) => path.join(dir, n))
    .sort();
}

const VAR_RE = /\$\{([A-Z_][A-Z0-9_]*)\}/g;

export function substitute(text: string, vars: Record<string, string>): string {
  return text.replace(VAR_RE, (m, name) => {
    const v = vars[name];
    return v !== undefined ? v : m;
  });
}
