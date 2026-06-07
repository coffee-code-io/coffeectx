// Package state defines the execution layer: a flat list of desired-state
// declarations ("states") that are read from the real system, diffed to produce
// actions, and applied. State types live behind a registry so new ones are easy
// to add.
package state

import (
	"context"
	"fmt"
)

// RawState is a single state element as decoded from CUE: a type tag, a stable
// name, and an opaque parameter bag that the matching handler decodes into a
// typed struct.
type RawState struct {
	Type   string
	Name   string
	Params map[string]any
}

// Action is one concrete mutation produced by Diff and consumed by Apply on the
// same handler. Payload is handler-private.
type Action struct {
	StateName string
	Kind      string // "install" | "write-file" | "run" | "set-env"
	Summary   string // human-readable line shown by plan
	Payload   any
}

// Desired is the handler-private typed params (e.g. *npmDesired).
type Desired any

// Observed is the handler-private snapshot of the real system for one state.
type Observed any

// StateHandler implements one state type (npm, file, env, ...).
type StateHandler interface {
	// Type returns the type tag, e.g. "npm".
	Type() string
	// Decode turns the generic CUE param bag into validated typed params.
	Decode(RawState) (Desired, error)
	// Read inspects the real/global system for the slice relevant to desired.
	Read(ctx context.Context, desired Desired) (Observed, error)
	// Diff compares desired vs observed; an empty slice means converged.
	Diff(desired Desired, observed Observed) ([]Action, error)
	// Apply executes one action against the real system.
	Apply(ctx context.Context, a Action) error
}

var registry = map[string]StateHandler{}

// Register installs a handler. Called from each handler's init().
func Register(h StateHandler) {
	if _, dup := registry[h.Type()]; dup {
		panic("coffeeenv: duplicate state handler: " + h.Type())
	}
	registry[h.Type()] = h
}

// Lookup returns the handler for a type tag.
func Lookup(typ string) (StateHandler, bool) {
	h, ok := registry[typ]
	return h, ok
}

// Resolved pairs a raw state with its handler and decoded desired value.
type Resolved struct {
	Handler StateHandler
	Desired Desired
	Raw     RawState
}

// DecodeStates dispatches each raw state to its handler and decodes params.
func DecodeStates(raws []RawState) ([]Resolved, error) {
	out := make([]Resolved, 0, len(raws))
	for i, rs := range raws {
		h, ok := Lookup(rs.Type)
		if !ok {
			return nil, fmt.Errorf("state[%d] %q: unknown type %q", i, rs.Name, rs.Type)
		}
		d, err := h.Decode(rs)
		if err != nil {
			return nil, fmt.Errorf("state[%d] (%s %q): %w", i, rs.Type, rs.Name, err)
		}
		out = append(out, Resolved{Handler: h, Desired: d, Raw: rs})
	}
	return out, nil
}

// Plan is the diff result: the ordered actions needed to converge, plus the
// count of states that were already up to date.
type Plan struct {
	Actions   []Action
	Unchanged int
}

// Engine runs the Read/Diff/Apply lifecycle over resolved states.
type Engine struct{}

// Plan reads the real system and diffs each state, accumulating actions.
func (Engine) Plan(ctx context.Context, resolved []Resolved) (Plan, error) {
	var p Plan
	for _, r := range resolved {
		obs, err := r.Handler.Read(ctx, r.Desired)
		if err != nil {
			return p, fmt.Errorf("read %s %q: %w", r.Raw.Type, r.Raw.Name, err)
		}
		acts, err := r.Handler.Diff(r.Desired, obs)
		if err != nil {
			return p, fmt.Errorf("diff %s %q: %w", r.Raw.Type, r.Raw.Name, err)
		}
		if len(acts) == 0 {
			p.Unchanged++
			continue
		}
		p.Actions = append(p.Actions, acts...)
	}
	return p, nil
}

// Apply executes the plan's actions in order, stopping on the first error.
func (Engine) Apply(ctx context.Context, p Plan) error {
	for _, a := range p.Actions {
		h, ok := Lookup(handlerTypeOf(a))
		if !ok {
			return fmt.Errorf("apply: no handler for action %q", a.Kind)
		}
		if err := h.Apply(ctx, a); err != nil {
			return fmt.Errorf("apply %s (%s): %w", a.StateName, a.Kind, err)
		}
	}
	return nil
}

// handlerTypeOf maps an action back to its handler type. Action.Kind is unique
// per handler so we route on it.
func handlerTypeOf(a Action) string {
	switch a.Kind {
	case "install-npm":
		return "npm"
	case "install-pnpm":
		return "pnpm"
	case "write-file":
		return "file"
	case "set-env":
		return "env"
	case "run":
		return "shell"
	}
	return ""
}
