/**
 * Shared knowledge-graph tool bodies.
 * Two adapters consume these: the MCP server (mcp/src/tools/) and the in-process
 * pi agent (indexer/src/agentRun/piTools.ts).
 */

export * as search from './search.js';
export * as exact from './exact.js';
export * as regex from './regex.js';
export * as rawQuery from './rawQuery.js';
export * as loadNode from './loadNode.js';
export * as upsertEntries from './upsertEntries.js';
export * as resolveSymbols from './resolveSymbols.js';

// `skills` tool was removed in the v2 skill refactor: pi-coding-agent's
// native ResourceLoader now handles skill discovery (slash commands +
// system-prompt injection), so the custom list_skills/get_skill tools
// became dead weight.
