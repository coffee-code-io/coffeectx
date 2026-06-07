#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Db, createEmbedFn, log } from '@coffeectx/core';
import { loadConfig } from './config.js';
import { registerSearchTool } from './tools/search.js';
import { registerExactTool } from './tools/exact.js';
import { registerRegexTool } from './tools/regex.js';
import { registerRawQueryTool } from './tools/rawQuery.js';
import { registerLoadNodeTool } from './tools/loadNode.js';
import { registerUpsertEntriesTool } from './tools/upsertEntries.js';
import { registerResolveSymbolsTool } from './tools/resolveSymbols.js';

const resolved = loadConfig();
const embedAuth = resolved.embed.auth;
const embedLabel = embedAuth
  ? embedAuth.authType === 'openai-oauth'
    ? 'openai-oauth'
    : (embedAuth.provider ?? embedAuth.url ?? '<unset>')
  : 'stub';
log(`[mcp] start project=${resolved.projectName} cwd=${process.cwd()} embed=${embedLabel} dbPath=${resolved.dbPath} pid=${process.pid}`);
log(`[mcp] tools config: ${JSON.stringify(resolved.tools)}`);

const embed = createEmbedFn(resolved.embed);
const db = new Db({ path: resolved.dbPath, embed, dimensions: resolved.embed.dimensions });

const server = new McpServer({ name: 'coffeectx', version: '0.1.0' });

const registeredTools: string[] = [];
function reg(name: string, fn: () => void) { fn(); registeredTools.push(name); }

if (resolved.tools.search) reg('search', () => registerSearchTool(server, db));
if (resolved.tools.exact) reg('exact', () => registerExactTool(server, db));
if (resolved.tools.regex) reg('regex', () => registerRegexTool(server, db));
if (resolved.tools.raw_query) reg('raw_query', () => registerRawQueryTool(server, db));
// Skills are no longer exposed as MCP tools — pi-coding-agent's native
// ResourceLoader handles agent-side skill discovery (system-prompt
// injection + `/skill:<name>` slash commands), and external MCP callers
// can read the skill files directly from `~/.coffeecode/skills/` and
// `~/.coffeecode/jobs/` if they need programmatic enumeration.
if (resolved.tools.load_node) reg('load_node', () => registerLoadNodeTool(server, db));
if (resolved.tools.exact) reg('resolve_symbols', () => registerResolveSymbolsTool(server, db));
if (resolved.tools.insert) reg('insert', () => registerUpsertEntriesTool(server, db));

log(`[mcp] registered tools (${registeredTools.length}): ${registeredTools.join(', ')}`);


const transport = new StdioServerTransport();
await server.connect(transport);
log(`[mcp] transport connected, server ready`);
