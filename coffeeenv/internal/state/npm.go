package state

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/coffeectx/coffeeenv/internal/sys"
)

func init() {
	Register(&pkgHandler{tool: "npm", actionKind: "install-npm"})
	Register(&pkgHandler{tool: "pnpm", actionKind: "install-pnpm"})
}

// pkgHandler implements both npm and pnpm — they differ only in the binary name
// and the global-add subcommand.
type pkgHandler struct {
	tool       string // "npm" | "pnpm"
	actionKind string
}

type pkgDesired struct {
	Package string   `json:"package"`
	Version string   `json:"version"`
	Prefix  string   `json:"prefix"`
	Bin     []string `json:"bin"`
}

// scope returns the install-location args: -g for a global install, or
// --prefix <dir> for a local one.
func (d *pkgDesired) scope() []string {
	if d.Prefix == "" {
		return []string{"-g"}
	}
	return []string{"--prefix", sys.ExpandPath(d.Prefix)}
}

// pkgObserved is the installed version found globally, or "" if absent.
type pkgObserved struct {
	Installed string
}

func (h *pkgHandler) Type() string { return h.tool }

func (h *pkgHandler) Decode(rs RawState) (Desired, error) {
	var p pkgDesired
	if err := decodeParams(rs, &p); err != nil {
		return nil, err
	}
	if p.Package == "" {
		return nil, fmt.Errorf("%s: package is required", h.tool)
	}
	if p.Version == "" {
		p.Version = "latest"
	}
	return &p, nil
}

func (h *pkgHandler) Read(ctx context.Context, desired Desired) (Observed, error) {
	d := desired.(*pkgDesired)
	if !sys.Look(h.tool) {
		// Tool not installed; treat the package as absent so a plan still renders.
		return &pkgObserved{}, nil
	}
	args := append([]string{"ls"}, d.scope()...)
	args = append(args, "--json", "--depth=0")
	res, err := sys.Run(ctx, h.tool, args...)
	if err != nil {
		return nil, err
	}
	// npm/pnpm exit non-zero when nothing matches; the JSON is still valid.
	return &pkgObserved{Installed: parseGlobalVersion(res.Stdout, d.Package)}, nil
}

func (h *pkgHandler) Diff(desired Desired, observed Observed) ([]Action, error) {
	d := desired.(*pkgDesired)
	o := observed.(*pkgObserved)

	spec := d.Package + "@" + d.Version
	where := "global"
	if d.Prefix != "" {
		where = d.Prefix
	}
	payload := pkgPayload{spec: spec, scope: d.scope()}
	switch {
	case o.Installed == "":
		return []Action{{
			StateName: d.Package,
			Kind:      h.actionKind,
			Summary:   fmt.Sprintf("install %s (%s)", spec, where),
			Payload:   payload,
		}}, nil
	case d.Version != "latest" && o.Installed != d.Version:
		return []Action{{
			StateName: d.Package,
			Kind:      h.actionKind,
			Summary:   fmt.Sprintf("update %s: %s -> %s (%s)", d.Package, o.Installed, d.Version, where),
			Payload:   payload,
		}}, nil
	default:
		// version=latest and present, or pinned and matched: leave it be.
		return nil, nil
	}
}

type pkgPayload struct {
	spec  string
	scope []string
}

func (h *pkgHandler) Apply(ctx context.Context, a Action) error {
	p := a.Payload.(pkgPayload)
	verb := "install"
	if h.tool == "pnpm" {
		verb = "add"
	}
	args := append([]string{verb}, p.scope...)
	args = append(args, p.spec)
	return sys.Stream(ctx, h.tool, args...)
}

// parseGlobalVersion extracts dependencies[pkg].version from `npm/pnpm ls -g
// --json` output. pnpm emits a JSON array of one project; npm emits an object.
func parseGlobalVersion(out, pkg string) string {
	type dep struct {
		Version string `json:"version"`
	}
	type tree struct {
		Dependencies map[string]dep `json:"dependencies"`
	}
	// Try object form (npm).
	var t tree
	if err := json.Unmarshal([]byte(out), &t); err == nil {
		if d, ok := t.Dependencies[pkg]; ok {
			return d.Version
		}
	}
	// Try array form (pnpm).
	var arr []tree
	if err := json.Unmarshal([]byte(out), &arr); err == nil {
		for _, e := range arr {
			if d, ok := e.Dependencies[pkg]; ok {
				return d.Version
			}
		}
	}
	return ""
}
