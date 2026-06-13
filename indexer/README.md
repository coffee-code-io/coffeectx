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

```bash
cd /path/to/your/repo
npx coffeectx init my-project    # enrol the repo (see flow below)
```

`init <name>` is a single-positional-arg enrol command. Two paths:

- **First time** (name not in `~/.coffeecode/config.yaml`): TTY prompts for six things — repo path (default `cwd`), LSP command (default `typescript-language-server --stdio`), which agent's logs to import (`claude` / `codex` / `pi` / `none`), embedding auth (apiKey only), indexer auth (apiKey or `openai-oauth`), UI agent auth (apiKey or `openai-oauth`). Then writes config, creates the project DB, syncs builtin types, and takes the first repo snapshot under `~/.coffeecode/snapshots/<name>/` so the `lsp` job has something to read on its first run. The `lsp`, `plans`, `span-link`, and `indexer` jobs are enabled by default; the chosen agent-log job (`claude`/`codex`/`pi`) is enabled with the derived path, the other two are registered with `enabled: false`.
- **Existing name**: skips prompts. Re-syncs builtin types into the DB (creates the DB if it's missing) and runs the first-snapshot pass against the configured `repoPath`. Idempotent — safe to re-invoke whenever you want to bootstrap from config alone (after a clone, or to seed snapshots manually).

Other helpers:

```bash
npx coffeectx sync-types         # sync built-in YAML types into the active DB
npx coffeectx job list           # see registered jobs (LSP, plans, indexer, …)
npx coffeectx job on <name>      # enable a job
```

The data directory defaults to `~/.coffeecode/`. Override it by exporting `COFFEECODE_HOME=/some/other/home` — coffeectx then reads/writes `$COFFEECODE_HOME/.coffeecode/` instead. Pi.dev's per-user state (auth tokens, settings, themes, …) is co-located under `$COFFEECODE_HOME/.coffeecode/.pi/agent/`, so a single env var moves both coffeectx and pi state together. (If you've already set `PI_CODING_AGENT_DIR` manually, your override wins.)

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
- **`authType: openai-oauth`** — uses pi.dev's OAuth Codex flow. Log in once with `npx coffeectx login openai-oauth` (or pi's own CLI); coffeectx reads the stored credentials at `$COFFEECODE_HOME/.coffeecode/.pi/agent/auth.json`. No other fields required. `login` writes only to that auth file — `~/.coffeecode/config.yaml` is untouched, so you can mix `openai-oauth` for one bucket with `apiKey` for another.

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
