// Package cmd implements the coffeeenv cobra CLI: pull, plan, apply, venv.
package cmd

import (
	"context"
	"fmt"
	"strings"

	"github.com/spf13/cobra"

	"github.com/coffeectx/coffeeenv/internal/chart"
	"github.com/coffeectx/coffeeenv/internal/cuelib"
	"github.com/coffeectx/coffeeenv/internal/state"
	"github.com/coffeectx/coffeeenv/internal/venv"
)

var rootCmd = &cobra.Command{
	Use:   "coffeeenv",
	Short: "Declarative environment manager for AI coding setups",
	Long: `coffeeenv renders a CUE chart into states and converges them.

Workflow:
  coffeeenv pull <source>          fetch a CUE chart into ~/.coffeeenv/charts
  coffeeenv plan  <chart>          show what would change on this machine
  coffeeenv apply <chart>          converge this machine to the chart
  coffeeenv venv create <name>     make a local environment
  coffeeenv apply --venv <name> <chart>   install the chart into the venv
  coffeeenv apply --materialize <name>    re-render the venv's chart globally`,
	SilenceUsage:  true,
	SilenceErrors: true,
}

// Execute runs the root command.
func Execute() error {
	return rootCmd.Execute()
}

func init() {
	rootCmd.AddCommand(pullCmd, planCmd, applyCmd, venvCmd)
}

// target is a resolved plan/apply destination: which chart to evaluate, with
// what engine context, and (for --venv) which venv to record a manifest into.
type target struct {
	chartName string
	chartDir  string
	opts      cuelib.Opts
	given     map[string]string // input values from --value (or the venv manifest)
	venv      *venv.Venv        // non-nil only in --venv mode (record manifest on apply)
	label     string
}

// resolveTarget turns the plan/apply flags into a concrete target. The three
// modes (default global, --venv local, --materialize global-from-manifest) are
// mutually exclusive.
func resolveTarget(chartArg, venvName, materialize string, values map[string]string) (target, error) {
	switch {
	case materialize != "":
		if venvName != "" || chartArg != "" {
			return target{}, fmt.Errorf("--materialize cannot be combined with --venv or a chart argument")
		}
		v, err := venv.Open(materialize)
		if err != nil {
			return target{}, err
		}
		if !v.Exists() {
			return target{}, fmt.Errorf("no venv %q — run `coffeeenv venv create %s` first", materialize, materialize)
		}
		m, err := v.ReadManifest()
		if err != nil {
			return target{}, fmt.Errorf("read venv manifest: %w", err)
		}
		if m.Chart == "" {
			return target{}, fmt.Errorf("venv %q has no chart installed; run `coffeeenv apply --venv %s <chart>` first", materialize, materialize)
		}
		c, err := resolveChart(m.Chart)
		if err != nil {
			return target{}, err
		}
		return target{
			chartName: m.Chart,
			chartDir:  c.Dir,
			opts:      cuelib.Opts{Engine: "global", Root: "~"},
			given:     m.Values,
			label:     fmt.Sprintf("materialize %s (chart %s)", materialize, m.Chart),
		}, nil

	case venvName != "":
		v, err := venv.Open(venvName)
		if err != nil {
			return target{}, err
		}
		if !v.Exists() {
			return target{}, fmt.Errorf("no venv %q — run `coffeeenv venv create %s` first", venvName, venvName)
		}
		c, err := resolveChart(chartArg)
		if err != nil {
			return target{}, err
		}
		return target{
			chartName: c.Name,
			chartDir:  c.Dir,
			opts:      cuelib.Opts{Engine: "local", Root: v.Dir},
			given:     values,
			venv:      &v,
			label:     fmt.Sprintf("venv %s (chart %s)", venvName, c.Name),
		}, nil

	default:
		c, err := resolveChart(chartArg)
		if err != nil {
			return target{}, err
		}
		return target{
			chartName: c.Name,
			chartDir:  c.Dir,
			opts:      cuelib.Opts{Engine: "global", Root: "~"},
			given:     values,
			label:     fmt.Sprintf("chart %s", c.Name),
		}, nil
	}
}

// parseValues turns repeated --value key=val flags into a map.
func parseValues(pairs []string) (map[string]string, error) {
	if len(pairs) == 0 {
		return nil, nil
	}
	m := make(map[string]string, len(pairs))
	for _, p := range pairs {
		k, v, ok := strings.Cut(p, "=")
		if !ok || k == "" {
			return nil, fmt.Errorf("invalid --value %q (want key=val)", p)
		}
		m[k] = v
	}
	return m, nil
}

// resolveChart resolves a chart by name, defaulting to the sole chart when the
// name is empty and exactly one chart exists.
func resolveChart(name string) (chart.Chart, error) {
	if name == "" {
		names, err := chart.List()
		if err != nil {
			return chart.Chart{}, err
		}
		switch len(names) {
		case 0:
			return chart.Chart{}, fmt.Errorf("no charts pulled — run `coffeeenv pull <source>` first")
		case 1:
			name = names[0]
		default:
			return chart.Chart{}, fmt.Errorf("multiple charts exist; specify one of: %v", names)
		}
	}
	c, err := chart.Open(name)
	if err != nil {
		return chart.Chart{}, err
	}
	if !c.Exists() {
		return chart.Chart{}, fmt.Errorf("no chart %q in ~/.coffeeenv/charts", name)
	}
	return c, nil
}

// computePlan resolves a target's chart inputs, decodes the states, and diffs
// them against the system. It returns the plan and the resolved values map (for
// recording into a venv manifest). prompt is nil for non-interactive callers.
func computePlan(ctx context.Context, t target, prompt cuelib.PromptFunc) (state.Plan, map[string]string, error) {
	r, err := cuelib.Resolve(t.chartDir, t.opts, t.given, prompt)
	if err != nil {
		return state.Plan{}, nil, err
	}
	resolved, err := state.DecodeStates(r.States)
	if err != nil {
		return state.Plan{}, nil, err
	}
	p, err := state.Engine{}.Plan(ctx, resolved)
	return p, r.Values, err
}
