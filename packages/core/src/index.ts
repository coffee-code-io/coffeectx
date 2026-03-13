export { Db } from './db.js';
export {
  loadConfig,
  saveConfig,
  updateConfig,
  resolveDbPath,
  dbPathForName,
  COFFEECODE_DIR,
  CONFIG_PATH,
  DB_DIR,
} from './config.js';
export type { CoffeectxConfig, ProjectEntry } from './config.js';
export type { DbOptions } from './db.js';
export { log } from './logger.js';
export { createEmbedFn, createOpenAIEmbed, createOpenRouterEmbed, createOllamaEmbed, stubEmbed, makeStubEmbed, loadEmbedConfig } from './embed/index.js';
export type { EmbedConfig, EmbedProvider } from './embed/index.js';
export { TypeCache } from './typeCache.js';
export {
  syncAllTypes,
  syncTypesFromDir,
  syncFromDir,
  loadYamlFromDir,
  loadYamlTypesFromDir,
  resolveYamlType,
  builtinTypesDir,
} from './builtin.js';
export type { YamlTypeSpec, YamlNamedTypeEntry, YamlSkillEntry, YamlTypeFile, YamlLoadResult, SyncResult, YamlDirFilter, SyncAllTypesOptions } from './builtin.js';
export { SCHEMA_DDL, VEC_TABLE_DDL, makeVecTableDDL } from './schema.js';
export { formatDeepNode } from './deepFormat.js';
export { parseQuery, executeQuery } from './query.js';
export type {
  Query,
  QueryClause,
  MapField,
  QueryDb,
} from './query.js';
export type {
  Sym,
  Meaning,
  Atom,
  Node,
  DeepNode,
  Type,
  StoredNode,
  SearchResult,
  InsertEntry,
  InsertResult,
  EmbedFn,
} from './types.js';
