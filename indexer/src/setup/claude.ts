/**
 * Claude Desktop MCP registration and CLAUDE.md integration.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// ── Path helpers ──────────────────────────────────────────────────────────────

function claudeDesktopConfigPath(): string {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  }
  // Linux (and fallback)
  return join(homedir(), '.config', 'Claude', 'claude_desktop_config.json');
}

// ── MCP server bin resolution ─────────────────────────────────────────────────

/**
 * Resolve the absolute path to the MCP server entry point.
 * 1. Try `require.resolve('@coffeectx/server')` (installed in node_modules).
 * 2. Fall back to sibling path `../../mcp/dist/index.js` relative to this file.
 */
export function getMcpServerBin(): string {
  const require = createRequire(import.meta.url);
  try {
    return require.resolve('@coffeectx/server');
  } catch {
    // Not installed as a linked package — use the workspace sibling path.
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    return join(__dirname, '..', '..', '..', 'mcp', 'dist', 'index.js');
  }
}

// ── Claude Desktop MCP registration ──────────────────────────────────────────

/**
 * Register the coffeectx MCP server in Claude Desktop's config JSON.
 * Creates the config file if it does not exist.
 */
export function registerMcpClaudeDesktop(mcpServerBin: string): void {
  const configPath = claudeDesktopConfigPath();
  mkdirSync(dirname(configPath), { recursive: true });

  let config: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    } catch {
      console.warn(`  Warning: could not parse ${configPath} — overwriting.`);
      config = {};
    }
  }

  if (!config['mcpServers'] || typeof config['mcpServers'] !== 'object') {
    config['mcpServers'] = {};
  }

  (config['mcpServers'] as Record<string, unknown>)['coffeectx'] = {
    command: 'node',
    args: [mcpServerBin],
  };

  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  console.log(`  Registered MCP server in: ${configPath}`);
}

// ── CLAUDE.md integration ─────────────────────────────────────────────────────

const SECTION_MARKER = '## CoffeeCtx';

/**
 * Append a CoffeeCtx instructions section to the project's CLAUDE.md.
 * Creates CLAUDE.md if it does not exist. Skips if the section is already present.
 */
export function appendClaudeMd(projectRepoPath: string, mcpServerBin: string): void {
  const claudeMdPath = join(projectRepoPath, 'CLAUDE.md');

  let existing = '';
  if (existsSync(claudeMdPath)) {
    existing = readFileSync(claudeMdPath, 'utf-8');
    if (existing.includes(SECTION_MARKER)) {
      console.log(`  CLAUDE.md already contains CoffeeCtx section — skipping.`);
      return;
    }
  }

  const projectName = basename(projectRepoPath);
  const section = `
${SECTION_MARKER}

CoffeeCtx is a knowledge graph MCP server that indexes your codebase, Claude logs, and
architecture decisions so you can query them with semantic and structural search.

### Available MCP tools

| Tool | Description |
|------|-------------|
| \`search\` | Semantic similarity search over indexed meanings |
| \`exact\` | Exact symbol value match |
| \`regex\` | Case-insensitive regex match against symbol values |
| \`raw_query\` | Structured query language (Symbol, Meaning, IsType, Field, HasItem, …) |

### Re-indexing

Run the indexer manually to pick up new changes:

\`\`\`sh
coffeectx-index index --project ${projectName}
\`\`\`

### Auto-indexing daemon

To start a background daemon that watches your logs and re-indexes automatically:

\`\`\`sh
coffeectx-index daemon --project ${projectName}
\`\`\`

### MCP server

The MCP server binary is at: \`${mcpServerBin}\`

To use it in another AI assistant, configure it as:
\`\`\`json
{
  "command": "node",
  "args": ["${mcpServerBin}"]
}
\`\`\`
`;

  const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  writeFileSync(claudeMdPath, existing + separator + section, 'utf-8');
  console.log(`  Updated: ${claudeMdPath}`);
}
