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

Initialise a project DB and edit `~/.coffeecode/config.yaml` directly. The CLI has discrete helpers for the pieces you'll need:

```bash
npx coffeectx init               # create + register a project (prompts for name)
npx coffeectx sync-types         # sync built-in YAML types into the active DB
npx coffeectx job list           # see registered jobs (LSP, plans, indexer, …)
npx coffeectx job on <name>      # enable a job
```

The data directory defaults to `~/.coffeecode/`. Override it by exporting `COFFEECODE_HOME=/some/other/home` — coffeectx then reads/writes `$COFFEECODE_HOME/.coffeecode/` instead.

### Auth schema

Every LLM credential block in `~/.coffeecode/config.yaml` — embeddings, UI agent, every job — uses the same `auth:` shape:

```yaml
auth:
  authType: apiKey                 # apiKey | openai-oauth
  provider: openrouter             # one of: openai | anthropic | openrouter
  # url: https://my-proxy/v1       # alternative to provider (OpenAI-compatible)
  model: anthropic/claude-haiku-4.5
  apiKey: sk-or-v1-...
```

Two modes:

- **`authType: apiKey`** — set exactly one of `provider:` (alias for a known base URL) or `url:` (custom OpenAI-compatible endpoint), plus `model` and `apiKey`.
- **`authType: openai-oauth`** — uses pi.dev's OAuth Codex flow. Log in once via pi's CLI; coffeectx reads the stored credentials. No other fields required.

Provider aliases:

| `provider:` | Base URL |
|---|---|
| `openai`     | `https://api.openai.com/v1` |
| `anthropic`  | `https://api.anthropic.com` |
| `openrouter` | `https://openrouter.ai/api/v1` |

Anthropic doesn't expose an embeddings API — `core.embed.auth.provider: anthropic` is rejected at config load.

Full project example:

```yaml
projects:
  my-project:
    db: /Users/me/.coffeecode/db/my-project.db
    repoPath: /Users/me/Documents/my-project
    created: 2026-06-01T00:00:00Z
    enabled: true
    core:
      embed:
        auth:
          authType: apiKey
          provider: openrouter
          model: openai/text-embedding-3-small
          apiKey: sk-or-v1-...
        dimensions: 1536
    agent:
      auth:
        authType: apiKey
        provider: openrouter
        model: anthropic/claude-haiku-4.5
        apiKey: sk-or-v1-...
    jobs:
      indexer:
        enabled: true
        parameters:
          auth:
            authType: apiKey
            provider: openrouter
            model: openai/gpt-5.4-nano
            apiKey: sk-or-v1-...
```

## Usage

### Start the scheduler

```bash
npx coffeectx daemonize
```

The scheduler runs every enabled job by its trigger:
- timer-based jobs (e.g. `claude`, `lsp`) on a configurable interval
- DB-triggered jobs (e.g. `indexer`) when a relevant node is inserted

### Trigger one job manually

```bash
npx coffeectx job trigger logs --now      # run inline
npx coffeectx job trigger logs            # queue for the running daemon
```

### Toggle jobs

Each job has a config entry under `jobs:` in `~/.coffeecode/config.yaml`. The CLI flips both the config and the live DB state — a running scheduler picks up the change within ~5s.

```bash
npx coffeectx job list
npx coffeectx job on lsp
npx coffeectx job off lsp-enrichment
npx coffeectx job status              # all jobs
npx coffeectx job status logs         # one job + recent runs
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
