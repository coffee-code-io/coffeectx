export { Db } from './db.js';
export {
  loadConfig,
  saveConfig,
  updateConfig,
  resolveDbPath,
  dbPathForName,
  resolveProjectEmbed,
  resolveProjectTools,
  resolveJobAuth,
  resolveAgentAuth,
  resolveSecretsProjectName,
  resolveJobParameters,
  resolveJobEnv,
  resolveSkillFilter,
  applySkillFilter,
  resolveProjectByCwd,
  listEnabledProjects,
  COFFEECODE_DIR,
  COFFEECODE_HOME,
  PI_AGENT_DIR,
  CONFIG_PATH,
  DB_DIR,
} from './config.js';
export type {
  CoffeectxConfig,
  ProjectEntry,
  EmbedSettings,
  AuthSettings,
  ToolsSettings,
  JobConfig,
  ProjectSkillsConfig,
  SkillFilter,
  SkillFilterTarget,
} from './config.js';
export type {
  DbOptions,
  InsertEvent,
  InsertListener,
  NodeEvent,
  NodeEventListener,
  JobRow,
  JobRunRow,
  JobStatus,
  JobResult,
  JobTriggerKind,
} from './db.js';
export { log } from './logger.js';
export { createEmbedFn, createOpenAIEmbed, createOpenRouterEmbed, makeStubEmbed } from './embed/index.js';
export {
  validateAuth,
  resolveAuth,
  STATIC_PROVIDER_URL,
  PROVIDER_TO_PI_ID,
  OAUTH_PI_PROVIDER_ID,
  CUSTOM_PI_PROVIDER_ID,
} from './auth.js';
export type { AuthMode, AuthProviderAlias, ResolvedAuth } from './auth.js';
export { TypeCache } from './typeCache.js';
export {
  syncAllTypes,
  syncTypesFromDir,
  syncFromDir,
  syncFromFile,
  loadYamlFromDir,
  loadYamlTypesFromDir,
  resolveYamlType,
  builtinTypesDir,
} from './builtin.js';
export type { YamlTypeSpec, YamlNamedTypeEntry, YamlTypeFile, YamlLoadResult, SyncResult, YamlDirFilter, SyncAllTypesOptions } from './builtin.js';
export { loadSkillsFromDir, loadAllSkills, defaultUserSkillsDir, defaultUserJobsDir, parseTriggers } from './skills.js';
export type { Skill, SkillTrigger, SkillJobSpec, SkillCategory, LoadAllSkillsOptions } from './skills.js';
export { SCHEMA_DDL, VEC_TABLE_DDL, makeVecTableDDL } from './schema.js';
export { formatDeepNode } from './deepFormat.js';
export { formatSpanMd } from './spanMd.js';
export type { SpanMdOptions } from './spanMd.js';
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
