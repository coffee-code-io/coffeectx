// Package cmd implements the coffeeenv cobra CLI: pull, plan, apply, venv.
package cmd

import (
	"context"
	"fmt"

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
	venv      *venv.Venv // non-nil only in --venv mode (record manifest on apply)
	label     string
}

// resolveTarget turns the plan/apply flags into a concrete target. The three
// modes (default global, --venv local, --materialize global-from-manifest) are
// mutually exclusive.
func resolveTarget(chartArg, venvName, materialize, valuesFile string) (target, error) {
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
			opts:      cuelib.Opts{Engine: "global", Root: "~", ValuesFile: m.ValuesFile},
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
			opts:      cuelib.Opts{Engine: "local", Root: v.Dir, ValuesFile: valuesFile},
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
			opts:      cuelib.Opts{Engine: "global", Root: "~", ValuesFile: valuesFile},
			label:     fmt.Sprintf("chart %s", c.Name),
		}, nil
	}
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

// computePlan evaluates a target's chart and diffs it against the system.
func computePlan(ctx context.Context, t target) (state.Plan, error) {
	raws, err := cuelib.EvalStates(t.chartDir, t.opts)
	if err != nil {
		return state.Plan{}, err
	}
	resolved, err := state.DecodeStates(raws)
	if err != nil {
		return state.Plan{}, err
	}
	return state.Engine{}.Plan(ctx, resolved)
}
