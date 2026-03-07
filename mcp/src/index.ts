#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Db } from '@retrival-mcp/core';
import type { EmbedFn } from '@retrival-mcp/core';
import { loadConfig } from './config.js';
import { registerSearchTool } from './tools/search.js';
import { registerExactTool } from './tools/exact.js';
import { registerRegexTool } from './tools/regex.js';
import { registerRawQueryTool } from './tools/rawQuery.js';
import { registerInsertTool } from './tools/insert.js';
import { registerSkillsTools } from './tools/skills.js';
import { registerLoadNodeTool } from './tools/loadNode.js';
import { registerInsertEntriesTool } from './tools/insertEntries.js';

const config = loadConfig();

const embed: EmbedFn = await (async () => {
  switch (config.embed.provider) {
    case 'openai': {
      const { createOpenAIEmbed } = await import('./embed/openai.js');
      return createOpenAIEmbed(config.embed);
    }
    case 'ollama': {
      const { createOllamaEmbed } = await import('./embed/ollama.js');
      return createOllamaEmbed(config.embed);
    }
    default:
      return (_text: string): Promise<Float32Array> => Promise.resolve(new Float32Array(128));
  }
})();

const db = new Db({ path: config.db.path, embed });

const server = new McpServer({ name: 'retrival-mcp', version: '0.1.0' });

if (config.tools.search) registerSearchTool(server, db);
if (config.tools.exact) registerExactTool(server, db);
if (config.tools.regex) registerRegexTool(server, db);
if (config.tools.raw_query) registerRawQueryTool(server, db);
if (config.tools.skills) registerSkillsTools(server, db);
if (config.tools.load_node) registerLoadNodeTool(server, db);
if (config.tools.insert) {
  registerInsertTool(server, db);
  registerInsertEntriesTool(server, db);
}

const transport = new StdioServerTransport();
await server.connect(transport);
