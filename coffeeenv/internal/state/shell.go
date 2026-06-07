package state

import (
	"context"
	"errors"
	"fmt"
	"os"

	"github.com/coffeectx/coffeeenv/internal/sys"
)

func init() { Register(&shellHandler{}) }

// shellHandler is the escape hatch: it runs an arbitrary command. Because
// commands are not naturally diffable, idempotency comes from optional
// ansible-style guards: `creates` (skip if path exists) and `unless` (skip if a
// probe command exits 0). With neither guard, the command runs on every apply.
type shellHandler struct{}

type shellDesired struct {
	Run     string `json:"run"`
	Creates string `json:"creates"`
	Unless  string `json:"unless"`
}

// shellObserved reports whether the guard is already satisfied.
type shellObserved struct {
	Satisfied bool
	Guarded   bool
}

func (shellHandler) Type() string { return "shell" }

func (shellHandler) Decode(rs RawState) (Desired, error) {
	var p shellDesired
	if err := decodeParams(rs, &p); err != nil {
		return nil, err
	}
	if p.Run == "" {
		return nil, errors.New("shell: run is required")
	}
	return &p, nil
}

func (shellHandler) Read(ctx context.Context, desired Desired) (Observed, error) {
	d := desired.(*shellDesired)
	switch {
	case d.Creates != "":
		_, err := os.Stat(sys.ExpandPath(d.Creates))
		return &shellObserved{Satisfied: err == nil, Guarded: true}, nil
	case d.Unless != "":
		res, err := sys.Run(ctx, "sh", "-c", d.Unless)
		if err != nil {
			return nil, err
		}
		return &shellObserved{Satisfied: res.ExitCode == 0, Guarded: true}, nil
	default:
		return &shellObserved{Satisfied: false, Guarded: false}, nil
	}
}

func (shellHandler) Diff(desired Desired, observed Observed) ([]Action, error) {
	d := desired.(*shellDesired)
	o := observed.(*shellObserved)
	if o.Satisfied {
		return nil, nil
	}
	summary := fmt.Sprintf("run: %s", d.Run)
	if !o.Guarded {
		summary += "  (no creates/unless guard — runs every apply)"
	}
	return []Action{{StateName: d.Run, Kind: "run", Summary: summary, Payload: d.Run}}, nil
}

func (shellHandler) Apply(ctx context.Context, a Action) error {
	return sys.Stream(ctx, "sh", "-c", a.Payload.(string))
}
