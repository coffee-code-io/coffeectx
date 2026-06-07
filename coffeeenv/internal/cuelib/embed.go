package cuelib

import "embed"

// libFS holds the bundled CUE library. The `all:` prefix ensures files inside
// cue.mod/ (and any dotfiles) are embedded too.
//
//go:embed all:lib
var libFS embed.FS

// libModule is the CUE module path of the bundled library. It MUST equal the
// `module:` field in lib/cue.mod/module.cue and the import prefix users write
// (e.g. import "coffeeenv.dev/lib/claude").
const libModule = "coffeeenv.dev/lib"
