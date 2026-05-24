# Example jobs

Each subdirectory here is a SKILL.md (Anthropic Agent Skills format) for a
**scheduler-driven job** — the scheduler picks up triggers from the
`coffeecode.job` block (or the per-project trigger override in
`~/.coffeecode/config.yaml`) and runs a fresh single-shot agent for each
fire.

Install:

```bash
cp -r examples/jobs/<name> ~/.coffeecode/jobs/
# Restart the indexer; open the Scheduler tab in the web UI and click
# "Configure" on the new row to wire up auth + env (and, optionally,
# trigger overrides).
```

## obsidian-worklog

Every morning, summarises yesterday's coding-agent sessions into an
Obsidian daily note under `<OBSIDIAN_VAULT>/Daily/<YYYY-MM-DD>.md`. The
job runs as a fresh agent that queries the graph for yesterday's events
and writes one file per run.

Required config in `~/.coffeecode/config.yaml`:

```yaml
projects:
  <your-project>:
    jobs:
      obsidian-worklog:
        enabled: true
        env:
          OBSIDIAN_VAULT: /Users/you/Documents/MyVault
        parameters:
          auth: { authType: anthropic, model: claude-sonnet-4-6, apiKey: sk-… }
```

Note: env vars declared on `coffeecode.requiredEnv` are injected as
literal values into the prompt (under an `## Environment` preamble) so
the agent — which has no JS sandbox — can substitute them directly
instead of asking the user for them.
