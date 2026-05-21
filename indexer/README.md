# @coffeectx/indexer

**Give your agents memory that matters.**

An MCP server + CLI that indexes agent session logs into a semantic knowledge graph. In a new session, agents can query the full history of past decisions, bugs, architecture choices, and implementation changes — no manual context-stuffing.

Tested with Claude Code. Supports semantic search, regex, and graph-like queries. Extensible: define new entity types and extraction skills.

Learn more at [coffeecode.io](https://coffeecode.io)

## Install

```bash
npm install -g @coffeectx/indexer
```

## Setup

Run the interactive setup wizard:

```bash
npx coffeectx-setup
```

This will walk you through:
- LLM provider and model selection — any model available through OpenRouter, OpenAI, or Anthropic can be used for indexing (including custom model IDs)
- Embedding model configuration
- Project setup (point to your repo paths)
- Optional daemon for auto-indexing
- MCP server registration for Claude Desktop
- CLAUDE.md instructions

## Usage

### Index your agent logs

```bash
npx coffeectx-index index
```

### Start the auto-indexing daemon

```bash
npx coffeectx-index daemon
```

### Add as MCP server

Add to your agent's MCP config:

```json
{
  "coffeectx": {
    "command": "node",
    "args": ["/path/to/node_modules/@coffeectx/server/dist/index.js"]
  }
}
```

The setup wizard (`coffeectx-setup`) can do this for you automatically.

## Features

- **Semantic Search** — plain-language queries that understand meaning
- **Regex Queries** — exact pattern matching for function names, error codes, config keys
- **Graph Traversal** — navigate relationships between decisions, files, bugs, features
- **Extensible Schema** — define custom entity types and extraction skills
- **MCP Native** — plugs into any MCP-compatible agent

## Links

- [coffeecode.io](https://coffeecode.io)
- [GitHub](https://github.com/coffee-code-io/coffeectx)
- [@aleksisfound](https://x.com/aleksisfound)

## License

MIT
