#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Db, createEmbedFn, log } from '@retrival-mcp/core';
import { loadConfig } from './config.js';
import { registerSearchTool } from './tools/search.js';
import { registerExactTool } from './tools/exact.js';
import { registerRegexTool } from './tools/regex.js';
import { registerRawQueryTool } from './tools/rawQuery.js';
import { registerSkillsTools } from './tools/skills.js';
import { registerLoadNodeTool } from './tools/loadNode.js';
import { registerUpsertEntriesTool } from './tools/upsertEntries.js';

const config = loadConfig();
log(`[mcp] start provider=${config.embed.provider} dbPath=${config.db.path} pid=${process.pid}`);

const embed = createEmbedFn(config.embed);
const db = new Db({ path: config.db.path, embed, dimensions: config.embed.dimensions });

const server = new McpServer({ name: 'retrival-mcp', version: '0.1.0' });

if (config.tools.search) registerSearchTool(server, db);
if (config.tools.exact) registerExactTool(server, db);
if (config.tools.regex) registerRegexTool(server, db);
if (config.tools.raw_query) registerRawQueryTool(server, db);
if (config.tools.skills) registerSkillsTools(server, db);
if (config.tools.load_node) registerLoadNodeTool(server, db);
if (config.tools.insert) registerUpsertEntriesTool(server, db);

const transport = new StdioServerTransport();
await server.connect(transport);
