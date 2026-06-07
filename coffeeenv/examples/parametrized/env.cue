// A parametrized chart demonstrating @input annotations and --value.
//   coffeeenv apply <chart> -V region=us-east-1 -V verbose=true
// region is asked first, verbose second (apply, on a TTY).
package env

import st "coffeeenv.dev/lib/states"

region:  string @input("Region (e.g. us-east-1)", order=1)
verbose: bool   @input("Verbose? (true/false)", order=2)

// derived: becomes concrete once the inputs are known.
_msg: "region=\(region) verbose=\(verbose)"

states: [
	st.#FileState & {
		name:    "cfg"
		path:    "/tmp/coffeeenv-demo/\(region).txt"
		content: _msg + "\n"
	},
]
