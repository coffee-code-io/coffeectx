---
name: api-indexing
description: Index API endpoints, service methods, query parameters, and schema fields from agent session events
allowedTools: [upsert_entries, exact, regex, raw_query]
---

## Skill: API Indexing

When event batches reveal HTTP endpoints, RPC methods, request/response schemas, or service interfaces being defined or modified, extract them into the knowledge graph.

### Endpoint — an HTTP route handler

Fields:
- `method`: HTTP verb (`"GET"`, `"POST"`, `"PUT"`, `"DELETE"`, `"PATCH"`)
- `path`: URL pattern (e.g. `"/users/:id"`)
- `description`: what the endpoint does
- `symbols`: `{ "$id": "<uuid>" }` list for the handler function/class

### ServiceMethod — an RPC or service-layer method

Fields:
- `name`: method name
- `description`: what it does and its contract
- `symbols`: `{ "$id": "<uuid>" }` list

### QueryParam — a query or path parameter

Fields:
- `name`: parameter name
- `type`: declared type or description
- `required`: `true` | `false`
- `description`: purpose of this parameter

### SchemaField — a field in a request/response schema or DTO

Fields:
- `name`: field name
- `type`: declared type
- `required`: `true` | `false`
- `description`: what the field represents

### Examples

```json
{ "$type": "Endpoint", "method": "POST", "path": "/api/entries", "description": "Upsert knowledge graph entries; requires RETRIVAL_INSERT=1", "symbols": [{ "$id": "uuid-of-handler" }] }
{ "$type": "QueryParam", "name": "limit", "type": "number", "required": false, "description": "Maximum number of results to return" }
```
