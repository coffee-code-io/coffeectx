// Identical to examples/claude-basic except the agent target — proving the
// skill / MCP / AGENTS.md features are polymorphic across agents.
package env

import (
	"coffeeenv.dev/lib/agent"
	"coffeeenv.dev/lib/agent/codex"
)

states: (agent.#Render & {
	targets: [
		codex.#Codex,
		agent.#RegisterAgentMd & {text: "# Project\n\nManaged by coffeeenv."},
		agent.#RegisterSkill & {skill: {
			name: "hello"
			body: "---\nname: hello\ndescription: Say hello\n---\n\nGreet the user warmly."
		}},
		agent.#RegisterMCP & {mcp: {
			name:    "filesystem"
			command: "npx"
			args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
		}},
	]
}).states
