// Package cuelib loads a chart's user CUE files, unifies them with the bundled
// CUE library (embedded and mounted as an importable module), injects the engine
// context, evaluates, and extracts the flat `states` list for the execution
// layer.
package cuelib

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"cuelang.org/go/cue"
	"cuelang.org/go/cue/cuecontext"
	"cuelang.org/go/cue/load"

	"github.com/coffeectx/coffeeenv/internal/state"
)

// userModule is the module path synthesized for the chart when it doesn't ship
// its own cue.mod/module.cue.
const userModule = "coffeeenv.dev/user"

// Opts carries the engine context injected into CUE and any extra values file.
type Opts struct {
	Engine     string // "global" | "local"
	Root       string // "~" for global; the venv dir for local
	ValuesFile string // optional path to a CUE values file unified into the chart
}

// EvalStates loads the chart's *.cue from chartDir, overlays the embedded
// library so `import "coffeeenv.dev/lib/..."` resolves, injects the engine
// context, evaluates, and returns the decoded flat states list.
func EvalStates(chartDir string, opts Opts) ([]state.RawState, error) {
	venvAbs, err := filepath.Abs(chartDir)
	if err != nil {
		return nil, err
	}

	overlay := map[string]load.Source{}
	if err := mountEmbed(overlay, venvAbs); err != nil {
		return nil, fmt.Errorf("mount cue library: %w", err)
	}
	ensureUserModule(overlay, venvAbs)
	injectContext(overlay, venvAbs, opts)
	if err := injectValues(overlay, venvAbs, opts); err != nil {
		return nil, err
	}

	cfg := &load.Config{Dir: venvAbs, Overlay: overlay}
	insts := load.Instances([]string{"."}, cfg)
	if len(insts) == 0 {
		return nil, fmt.Errorf("no CUE instances found in %s", venvAbs)
	}
	inst := insts[0]
	if inst.Err != nil {
		return nil, fmt.Errorf("load CUE: %w", inst.Err)
	}

	ctx := cuecontext.New()
	v := ctx.BuildInstance(inst)
	if err := v.Err(); err != nil {
		return nil, fmt.Errorf("build CUE: %w", err)
	}
	// Validate the whole value so assertions in hidden fields (e.g.
	// context.#Require) surface even when `states` doesn't reference them.
	if err := v.Validate(); err != nil {
		return nil, fmt.Errorf("evaluate CUE: %w", err)
	}

	statesV := v.LookupPath(cue.ParsePath("states"))
	if !statesV.Exists() {
		return nil, fmt.Errorf("CUE evaluates to no top-level `states` field")
	}
	if err := statesV.Validate(cue.Concrete(true)); err != nil {
		return nil, fmt.Errorf("`states` is not concrete: %w", err)
	}
	return decodeRawStates(statesV)
}

// mountEmbed walks the embedded lib/ tree and overlays every package file under
// <venv>/cue.mod/pkg/coffeeenv.dev/lib/... — the location CUE resolves external
// imports from. The library's own cue.mod/ is skipped.
func mountEmbed(overlay map[string]load.Source, venvAbs string) error {
	pkgRoot := filepath.Join(venvAbs, "cue.mod", "pkg", filepath.FromSlash(libModule))
	return fs.WalkDir(libFS, "lib", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		rel := strings.TrimPrefix(p, "lib/")
		if strings.HasPrefix(rel, "cue.mod/") {
			return nil // skip the library's own module marker
		}
		data, err := libFS.ReadFile(p)
		if err != nil {
			return err
		}
		overlay[filepath.Join(pkgRoot, filepath.FromSlash(rel))] = load.FromBytes(data)
		return nil
	})
}

// injectContext overlays a concrete context/_inject.cue into the mounted
// library so library helpers see the active engine/root. This unifies with the
// embedded context schema and avoids relying on CUE tag injection reaching
// imported packages.
func injectContext(overlay map[string]load.Source, venvAbs string, opts Opts) {
	if opts.Engine == "" {
		return
	}
	root := opts.Root
	if root == "" {
		root = "~"
	}
	pkgRoot := filepath.Join(venvAbs, "cue.mod", "pkg", filepath.FromSlash(libModule))
	// NB: CUE's loader ignores files beginning with "_" or ".", so the injected
	// file must not start with an underscore.
	path := filepath.Join(pkgRoot, "context", "inject.cue")
	src := fmt.Sprintf("package context\nengine: %q\nroot: %q\n", opts.Engine, root)
	overlay[path] = load.FromString(src)
}

// injectValues overlays a user-supplied values file into the chart instance so
// it unifies with the chart (convention: charts and values are `package env`).
func injectValues(overlay map[string]load.Source, venvAbs string, opts Opts) error {
	if opts.ValuesFile == "" {
		return nil
	}
	data, err := os.ReadFile(opts.ValuesFile)
	if err != nil {
		return fmt.Errorf("read values file: %w", err)
	}
	overlay[filepath.Join(venvAbs, "coffeeenv_values.cue")] = load.FromBytes(data)
	return nil
}

// ensureUserModule overlays a minimal cue.mod/module.cue for the chart if one is
// not already present, so the chart counts as a module and imports resolve.
func ensureUserModule(overlay map[string]load.Source, venvAbs string) {
	modPath := filepath.Join(venvAbs, "cue.mod", "module.cue")
	if _, err := os.Stat(modPath); err == nil {
		return // exists on disk; respect it
	}
	overlay[modPath] = load.FromString(fmt.Sprintf("module: %q\nlanguage: version: \"v0.9.0\"\n", userModule))
}

// decodeRawStates decodes the `states` list as generic maps, then splits each
// element into a typed/name/params triple.
func decodeRawStates(statesV cue.Value) ([]state.RawState, error) {
	var maps []map[string]any
	if err := statesV.Decode(&maps); err != nil {
		return nil, fmt.Errorf("decode states: %w", err)
	}
	out := make([]state.RawState, 0, len(maps))
	for i, m := range maps {
		typ, _ := m["type"].(string)
		if typ == "" {
			return nil, fmt.Errorf("states[%d]: missing `type`", i)
		}
		name, _ := m["name"].(string)
		params := make(map[string]any, len(m))
		for k, val := range m {
			if k == "type" {
				continue
			}
			params[k] = val
		}
		out = append(out, state.RawState{Type: typ, Name: name, Params: params})
	}
	return out, nil
}
