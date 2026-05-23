# @coffeectx/pi-plugin

Expose the coffeectx knowledge graph to pi.dev (`@earendil-works/pi-coding-agent`) as a set of in-process tools. Pi.dev does not speak MCP — this package is the equivalent integration point.

## Install

```bash
npm i -g @coffeectx/pi-plugin
```

(or `npm i @coffeectx/pi-plugin` inside the project where you run pi.)

## Hook up

Drop a file at `~/.pi/agent/extensions/coffeectx.ts`:

```ts
export { default } from '@coffeectx/pi-plugin';
```

Inside a running pi session, `/reload` picks it up. The next `/tools` listing should include `search`, `get_by_symbol_text`, `regex`, `raw_query`, `get_node_by_id`, `list_skills`, `get_skill`, `resolve_symbols`, and (if enabled) `upsert_entries`.

## How it picks the project

On registration, the plugin reads `~/.coffeecode/config.yaml`, then resolves `process.cwd()` against the `repoPath` of each enabled project. The most specific match wins (handles macOS `/tmp ↔ /private/tmp` realpath). If nothing matches, the plugin logs a one-liner to stderr and registers no tools — the extension is a no-op rather than a crash.

## `upsert_entries` gating

`upsert_entries` is the write tool. It's only registered when the project's `mcp.tools.insert` flag is `true` (same flag that gates the external MCP server's exposure of it). Default is read-only.

## Project layout you need

```
~/.coffeecode/
├── config.yaml                # has at least one project with `repoPath` matching your cwd
└── db/<project>.db            # the actual SQLite knowledge graph
```

If you've already configured the MCP server, the plugin uses the same config — no extra setup.
