// A minimal Claude Code chart. Engine-aware: `apply` installs globally,
// `apply --venv <name>` installs into the venv. `coffeeenv pull ./examples/claude-basic`.
package env

import (
	"coffeeenv.dev/lib/claude"
	"coffeeenv.dev/lib/context"
	st "coffeeenv.dev/lib/states"
)

_claude: claude.#Install & {
	version:  "latest"
	claudeMd: "# Claude Basic\n\nManaged by coffeeenv.\n"
	settings: permissions: allow: ["Bash(jq:*)"]
	mcp: {}
}

// env file target: the venv's env.sh under the local engine, else the global one.
_envTarget: *"" | string
if context.engine == "local" {
	_envTarget: "\(context.root)/env.sh"
}

states: [
	for s in _claude.states {s},
	st.#EnvState & {name: "EDITOR", value: "nvim", target: _envTarget},
	st.#FileState & {
		name:    "marker"
		path:    "\(context.root)/.config/coffeeenv/hello.txt"
		content: "hi from coffeeenv\n"
	},
]
