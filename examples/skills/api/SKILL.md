---
name: api
description: Extract the local API surface (HTTP endpoints, CLI subcommands, public interface methods, MCP tools, named schemas) when the span touches route handlers, CLI entry points, interface definitions, or MCP server registrations.
coffeecode:
  indexer: true
  types: ./types.yaml
allowed-tools: [upsert_entries, get_by_symbol_text, resolve_symbols, regex, raw_query, search, get_node_by_id]
---

# API-surface extraction

You are extending the per-Span indexer. The base indexer prompt already taught you the Span format, the upsert contract, and the built-in types. This skill adds five API-surface types: `Endpoint`, `CliCommand`, `InterfaceMethod`, `McpTool`, `ApiSchema`.

Invoke me only when the span clearly touches one of these surfaces. Heuristics: handler registrations (`app.get('/x', …)`, `router.post`, websocket attach), CLI subcommand registration (`case 'cmd':`, commander/yargs definitions), MCP tool registration (`server.tool(...)`, `defineTool`, `addTool`), public class/interface methods that look like an API contract (documented, exported, called from outside the module).

# What to extract

For each surface type, find the LSP symbol that implements it (use `get_by_symbol_text` / `resolve_symbols` against the handler/function name visible in the span's diff) and cite it via `{ "$id": "<uuid>" }`. If you can't resolve the symbol, **still emit the entry** with an empty `symbol` field — the surface itself is the higher-signal record.

## Endpoint — one per HTTP route or WebSocket handler
- `path` — URL pattern, e.g. `"/api/users/:id"`
- `method` — uppercase verb: `"GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "WS"`
- `description` — what the endpoint does (one sentence)
- `handler` — function name
- `tags` — feature/area/auth-level groupings
- `symbol` — `{ "$id": "<uuid-of-LspFunction-or-LspMethod>" }`

```json
{ "$type": "Endpoint", "path": "/api/users/:id", "method": "GET", "description": "Fetch a user by id", "handler": "getUser", "tags": ["users"], "symbol": { "$id": "<uuid>" } }
```

## CliCommand — one per CLI subcommand
- `name` — command name (e.g. `"index"`, `"sync-types"`)
- `description` — what it does
- `args` — positional argument names
- `flags` — flag names with leading dashes (e.g. `"--project"`, `"--dry-run"`)
- `symbol` — `{ "$id": "<uuid>" }`

```json
{ "$type": "CliCommand", "name": "init", "description": "Create a new project DB and register it", "args": [], "flags": ["--name"], "symbol": { "$id": "<uuid>" } }
```

## InterfaceMethod — one per public method on an exported class or interface
- `interface` — class or interface name
- `name` — method name
- `signature` — full TS signature
- `description` — what the method does
- `symbol` — `{ "$id": "<uuid>" }`

```json
{ "$type": "InterfaceMethod", "interface": "Db", "name": "insertEntries", "signature": "(entries: InsertEntry[]): Promise<InsertResult>", "description": "Batch-insert typed nodes into the knowledge graph", "symbol": { "$id": "<uuid>" } }
```

## McpTool — one per tool registered in an MCP server
- `name` — tool name as registered (e.g. `"search"`)
- `description` — what the tool does
- `inputSchema` — Zod schema or type name
- `symbol` — `{ "$id": "<uuid>" }`

```json
{ "$type": "McpTool", "name": "search", "description": "Semantic similarity search over the knowledge graph", "inputSchema": "SearchInput", "symbol": { "$id": "<uuid>" } }
```

## ApiSchema — one per named DTO / request-response shape / config type
- `name` — schema/type name
- `description` — what data this shape represents
- `symbol` — `{ "$id": "<uuid-of-LspInterface-or-LspClass>" }`

```json
{ "$type": "ApiSchema", "name": "SearchInput", "description": "Semantic-search query payload", "symbol": { "$id": "<uuid>" } }
```

# Rules

- Emit nothing if the span only modifies internals (no public-surface change).
- Don't duplicate: an `Endpoint` and an `InterfaceMethod` describing the same handler — pick the most external view (the endpoint).
- Skill output complements (does not replace) the base indexer's built-in extractions; still emit `LocalDecision` / `Decision` / `Assumption` / `ChangeEvent` / comment-patches where relevant.
