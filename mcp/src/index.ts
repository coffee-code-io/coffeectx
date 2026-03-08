#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Db, createEmbedFn } from '@retrival-mcp/core';
import { loadConfig } from './config.js';
import { registerSearchTool } from './tools/search.js';
import { registerExactTool } from './tools/exact.js';
import { registerRegexTool } from './tools/regex.js';
import { registerRawQueryTool } from './tools/rawQuery.js';
import { registerInsertTool } from './tools/insert.js';
import { registerSkillsTools } from './tools/skills.js';
import { registerLoadNodeTool } from './tools/loadNode.js';
import { registerInsertEntriesTool } from './tools/insertEntries.js';
import { registerAnnotateNodeTool } from './tools/annotateNode.js';

const config = loadConfig();
import { appendFileSync } from 'node:fs';
const _diagLine = `[mcp] embed provider=${config.embed.provider} apiKey=${config.embed.apiKey} dbPath=${config.db.path} pid=${process.pid}\n`;
try { appendFileSync('/tmp/retrival-mcp-diag.log', _diagLine); } catch { /* ignore */ }
const _rawEmbed = createEmbedFn(config.embed);
const embed: typeof _rawEmbed = async (text) => {
  try {
    const vec = await _rawEmbed(text);
    const nonzero = vec.filter(v => v !== 0).length;
    try { appendFileSync('/tmp/retrival-mcp-diag.log', `embed(${JSON.stringify(text.slice(0,40))}) → nonzero=${nonzero}\n`); } catch { /* ignore */ }
    return vec;
  } catch (err) {
    try { appendFileSync('/tmp/retrival-mcp-diag.log', `embed(${JSON.stringify(text.slice(0,40))}) THREW: ${(err as Error).message}\n`); } catch { /* ignore */ }
    throw err;
  }
};
const db = new Db({ path: config.db.path, embed, dimensions: config.embed.dimensions });

const server = new McpServer({ name: 'retrival-mcp', version: '0.1.0' });

if (config.tools.search) registerSearchTool(server, db);
if (config.tools.exact) registerExactTool(server, db);
if (config.tools.regex) registerRegexTool(server, db);
if (config.tools.raw_query) registerRawQueryTool(server, db);
if (config.tools.skills) registerSkillsTools(server, db);
if (config.tools.load_node) registerLoadNodeTool(server, db);
if (config.tools.insert) {
  // registerInsertTool(server, db);
  registerInsertEntriesTool(server, db);
}
// registerAnnotateNodeTool(server, db);

const transport = new StdioServerTransport();
await server.connect(transport);
