---
name: contract
description: Capture local data contracts, argument validators, and entity relationships when the span touches validation logic, schema files, function preconditions, or domain-model definitions.
coffeecode:
  indexer: true
  types: ./types.yaml
allowed-tools: [upsert_entries, get_by_symbol_text, resolve_symbols, regex, raw_query, search, get_node_by_id]
---

# Contract & entity-relation extraction

You are extending the per-Span indexer. The base prompt already taught you the Span format and built-in types. This skill adds five contract / data-model types: `TextContract`, `ArgValidator`, `EntityMapping`, `Unique`, `Relation`.

Invoke me when the span touches Zod/Joi/Yup schemas, JSDoc-annotated preconditions, DB schema files (SQL/Prisma/Drizzle), interface definitions carrying semantic constraints, or domain entity relationships.

# What to extract

## TextContract — informal agreement between two modules / functions
- `description` — what the contract says
- `parties` — function/module names involved
- `obligations` — one per party

```json
{ "$type": "TextContract", "description": "Caller must embed all meanings before passing embedMap to buildEntryNode", "parties": ["insertEntries", "buildEntryNode"], "obligations": ["insertEntries pre-computes all embeddings", "buildEntryNode reads from embedMap synchronously"] }
```

## ArgValidator — a validation rule on a function argument
- `function` — fully qualified name (e.g. `"Db.insertEntries"`)
- `argument` — parameter name
- `rule` — the invariant
- `errorMessage` — the error returned when violated
- `symbol` — `{ "$id": "<uuid-of-LspFunction-or-LspMethod>" }`

```json
{ "$type": "ArgValidator", "function": "resolveYamlType", "argument": "spec", "rule": "Or/And kinds require at least 2 types in the types array", "errorMessage": "Or requires at least 2 types", "symbol": { "$id": "<uuid>" } }
```

## EntityMapping — a cardinality relationship between two entities
- `from` / `to` — entity names
- `cardinality` — `"1-1" | "1-many" | "many-1" | "many-many"`
- `description` — meaning

```json
{ "$type": "EntityMapping", "from": "Skill", "to": "NamedType", "cardinality": "1-many", "description": "A skill references the named types it creates entries for" }
```

## Unique — uniqueness constraint (DB index, business rule)
- `entity` — entity/table name
- `fields` — field names forming the unique key
- `description` — why this constraint exists

```json
{ "$type": "Unique", "entity": "named_types", "fields": ["name"], "description": "Named type names must be globally unique — the registry resolves by name" }
```

## Relation — a named directed relation between two entities
- `from` / `to`
- `name` — verb/phrase (e.g. `"owns"`, `"depends-on"`)
- `type` — `"association" | "aggregation" | "composition" | "dependency"`
- `cardinality` — `"1-1" | "1-many" | "many-many"`
- `description`

```json
{ "$type": "Relation", "from": "Project", "to": "Db", "name": "owns", "type": "composition", "cardinality": "1-1", "description": "Each project owns exactly one SQLite database file" }
```

# Rules

- Don't fabricate cardinality — only emit `EntityMapping` / `Relation` when the cardinality is *demonstrable* from the diff (schema definition, foreign key, list field).
- One `Unique` per actual constraint declaration; don't bundle multiple constraints into one row.
- Skill output complements the base indexer's built-in extractions — still emit `LocalDecision`/`Decision`/`Assumption`/`ChangeEvent`/comment-patches where the span justifies them.
