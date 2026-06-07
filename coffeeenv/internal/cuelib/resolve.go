package cuelib

import (
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"

	"cuelang.org/go/cue"

	"github.com/coffeectx/coffeeenv/internal/state"
)

// Input is a chart field marked promptable with @input("prompt", order=N).
type Input struct {
	Name   string
	Prompt string
	Order  int
}

// PromptFunc resolves an input value interactively. A nil PromptFunc means
// non-interactive: unresolved inputs become an error.
type PromptFunc func(Input) (string, error)

// Result is the outcome of resolution: the final values map (for the manifest)
// and the decoded flat states list.
type Result struct {
	Values map[string]string
	States []state.RawState
}

// Resolve builds the chart, fills in the given values, and iteratively resolves
// remaining @input fields (re-rendering after each so CUE propagation can fix
// dependents). Non-annotated non-fixed top-level fields are an error.
func Resolve(chartDir string, opts Opts, given map[string]string, prompt PromptFunc) (Result, error) {
	ctx, base, err := buildBase(chartDir, opts)
	if err != nil {
		return Result{}, err
	}

	inputs, variables, err := scanFields(base)
	if err != nil {
		return Result{}, err
	}

	values := map[string]string{}
	for k, v := range given {
		values[k] = v
	}

	for {
		cur, err := fillValues(ctx, base, values)
		if err != nil {
			return Result{}, err
		}

		var promptable []Input
		var badGiven, plain []string
		for _, name := range variables {
			if fieldFixed(cur, name) {
				continue
			}
			if in, ok := inputs[name]; ok {
				if _, given := values[name]; given {
					badGiven = append(badGiven, name)
				} else {
					promptable = append(promptable, in)
				}
			} else {
				plain = append(plain, name)
			}
		}

		if len(promptable) > 0 {
			if prompt == nil {
				return Result{}, missingInputsErr(promptable, plain)
			}
			sort.Slice(promptable, func(i, j int) bool {
				if promptable[i].Order != promptable[j].Order {
					return promptable[i].Order < promptable[j].Order
				}
				return promptable[i].Name < promptable[j].Name
			})
			next := promptable[0]
			val, err := prompt(next)
			if err != nil {
				return Result{}, err
			}
			values[next.Name] = val
			continue
		}

		if len(badGiven) > 0 || len(plain) > 0 {
			return Result{}, unresolvedErr(cur, badGiven, plain)
		}

		statesV := cur.LookupPath(cue.ParsePath("states"))
		if !statesV.Exists() {
			return Result{}, fmt.Errorf("chart has no top-level `states` field")
		}
		if err := statesV.Validate(cue.Concrete(true)); err != nil {
			return Result{}, fmt.Errorf("`states` is not concrete: %w", err)
		}
		raws, err := decodeRawStates(statesV)
		if err != nil {
			return Result{}, err
		}
		return Result{Values: values, States: raws}, nil
	}
}

// scanFields reads @input metadata and the set of top-level variable names
// (regular fields except `states`) from the base value.
func scanFields(base cue.Value) (map[string]Input, []string, error) {
	inputs := map[string]Input{}
	var variables []string

	it, err := base.Fields()
	if err != nil {
		return nil, nil, err
	}
	for it.Next() {
		name := it.Selector().String()
		if name == "states" {
			continue
		}
		variables = append(variables, name)

		attr := it.Value().Attribute("input")
		if attr.Err() != nil {
			continue
		}
		prompt, _ := attr.String(0)
		order := math.MaxInt32
		if s, found, _ := attr.Lookup(0, "order"); found {
			if n, err := strconv.Atoi(strings.TrimSpace(s)); err == nil {
				order = n
			}
		}
		inputs[name] = Input{Name: name, Prompt: prompt, Order: order}
	}
	return inputs, variables, nil
}

// fillValues unifies the given key=val pairs into the base value, inferring each
// value's type.
func fillValues(ctx *cue.Context, base cue.Value, values map[string]string) (cue.Value, error) {
	cur := base
	for k, v := range values {
		cur = cur.FillPath(cue.MakePath(cue.Str(k)), encodeTyped(ctx, v))
	}
	if err := cur.Err(); err != nil {
		return cue.Value{}, err
	}
	return cur, nil
}

// fieldFixed reports whether a top-level field is concrete in cur.
func fieldFixed(cur cue.Value, name string) bool {
	fv := cur.LookupPath(cue.MakePath(cue.Str(name)))
	return fv.Exists() && fv.Validate(cue.Concrete(true)) == nil
}

// encodeTyped turns a flag string into a typed cue.Value: true/false -> bool,
// integer/float -> number, otherwise string.
func encodeTyped(ctx *cue.Context, s string) cue.Value {
	if b, err := strconv.ParseBool(s); err == nil && (s == "true" || s == "false") {
		return ctx.Encode(b)
	}
	if i, err := strconv.ParseInt(s, 10, 64); err == nil {
		return ctx.Encode(i)
	}
	if f, err := strconv.ParseFloat(s, 64); err == nil {
		return ctx.Encode(f)
	}
	return ctx.Encode(s)
}

func missingInputsErr(promptable []Input, plain []string) error {
	var b strings.Builder
	b.WriteString("missing inputs (pass --value NAME=...):")
	sort.Slice(promptable, func(i, j int) bool { return promptable[i].Name < promptable[j].Name })
	for _, in := range promptable {
		fmt.Fprintf(&b, "\n  %s — %s", in.Name, in.Prompt)
	}
	for _, n := range plain {
		fmt.Fprintf(&b, "\n  %s (no @input annotation)", n)
	}
	return fmt.Errorf("%s", b.String())
}

func unresolvedErr(cur cue.Value, badGiven, plain []string) error {
	var b strings.Builder
	b.WriteString("unresolved fields:")
	for _, n := range badGiven {
		reason := ""
		if err := cur.LookupPath(cue.MakePath(cue.Str(n))).Err(); err != nil {
			reason = ": " + err.Error()
		}
		fmt.Fprintf(&b, "\n  %s (value conflicts%s)", n, reason)
	}
	for _, n := range plain {
		fmt.Fprintf(&b, "\n  %s (not concrete and has no @input annotation)", n)
	}
	return fmt.Errorf("%s", b.String())
}
