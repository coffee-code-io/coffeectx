/**
 * Skills directory tools: list all skills, fetch one by name.
 */

import type { Db } from '@coffeectx/core';

export const listDescription =
  'List all indexing skills available in the knowledge graph. Each skill has a name, description, and the set of types it uses.';

export const getDescription =
  'Get a specific indexing skill by name, including its full prompt and the list of types it uses.';

export interface ListResult {
  name: string;
  description: string | null;
  source: string;
  types: string[];
}

export function runList(db: Db): ListResult[] {
  return db.listSkills().map(s => ({
    name: s.name,
    description: s.description,
    source: s.source,
    types: s.types,
  }));
}

export interface GetParams {
  name: string;
}

export interface GetResult {
  name: string;
  description: string | null;
  prompt: string;
  source: string;
  types: string[];
  typeDetails: { name: string; description: string | null }[];
}

export function runGet(db: Db, p: GetParams): GetResult | null {
  const skill = db.getSkill(p.name);
  if (!skill) return null;
  const typeDetails = skill.types.map(typeName => {
    const entry = db.loadNamedType(typeName);
    return { name: typeName, description: entry?.description ?? null };
  });
  return { ...skill, typeDetails };
}
