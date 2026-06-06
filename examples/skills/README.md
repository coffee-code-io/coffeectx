# Example agent skills

Each subdirectory here is a SKILL.md (Anthropic Agent Skills format) meant
for **agent loading** — pi's ResourceLoader surfaces them as
`/skill:<name>` slash commands and adds them to the agent's system prompt.
They aren't scheduled — see `../jobs/` for scheduler-driven SKILL.md files.

Install one by copying it:

```bash
cp -r examples/skills/<name> ~/.coffeecode/skills/
# Restart the indexer / UI server; then open the Skills tab in the
# web UI and toggle which agents see it.
```

## Indexer skills

Skills whose front-matter sets `coffeecode.indexer: true` are surfaced
specially by the per-Span indexer job (`indexer/src/agentRun/runSpanIndexer.ts`):
their `name` + `description` are listed in the agent's system prompt as a
routing catalog, and the agent invokes `/skill:<name>` when a span's
content matches the skill's description.

Three indexer skills ship as examples:

- **`api/`** — extract HTTP endpoints, CLI subcommands, public interface
  methods, MCP tools, and named DTO schemas. Activate on spans that touch
  route handlers, CLI entry points, interface definitions, or MCP server
  registrations.
- **`concurrency/`** — extract concurrency invariants, happens-before
  orderings, and synced-with relationships. Activate on spans that touch
  shared state, locks, transactions, or event ordering.
- **`contract/`** — extract textual contracts, argument validators,
  uniqueness constraints, entity mappings, and named domain relations.
  Activate on spans that touch validation logic, schema files, or
  domain-model definitions.

Each skill ships with its own `types.yaml` (contributed via
`coffeecode.types: ./types.yaml`) — installing the skill adds those types
to the project's schema; uninstalling removes them.

Drop your own SKILL.md directories alongside these — the agent-skills
format is the same.
