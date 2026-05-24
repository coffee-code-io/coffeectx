# Example agent skills

Each subdirectory here is a SKILL.md (Anthropic Agent Skills format) meant
for **agent loading** — pi's ResourceLoader surfaces them as
`/skill:<name>` slash commands and adds them to the agent's system prompt.
They aren't scheduled — see `../jobs/` for scheduler-driven SKILL.md
files.

Install one by copying it:

```bash
cp -r examples/skills/<name> ~/.coffeecode/skills/
# Restart the indexer / UI server; then open the Skills tab in the
# web UI and toggle which agents see it.
```

(No example skills shipped yet — drop your own SKILL.md directories here.
The agent-skills format is the same as for jobs, just no `coffeecode.job`
block.)
