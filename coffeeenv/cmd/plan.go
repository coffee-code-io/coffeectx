package cmd

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/spf13/cobra"

	"github.com/coffeectx/coffeeenv/internal/state"
)

var (
	planJSON        bool
	planVenv        string
	planMaterialize string
	planValues      string
)

var planCmd = &cobra.Command{
	Use:   "plan [chart]",
	Short: "Show what would change",
	Long: `Render a chart and show the actions needed to converge.

Modes:
  plan [chart]              against the real system (engine=global)
  plan --venv <name> <chart>   into a local venv (engine=local)
  plan --materialize <name>    re-render the venv's chart against the real system`,
	Args: cobra.MaximumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		t, err := resolveTarget(firstArg(args), planVenv, planMaterialize, planValues)
		if err != nil {
			return err
		}
		p, err := computePlan(cmd.Context(), t)
		if err != nil {
			return err
		}
		if planJSON {
			return printPlanJSON(p)
		}
		fmt.Printf("Target: %s\n", t.label)
		printPlan(p)
		return nil
	},
}

func init() {
	planCmd.Flags().BoolVar(&planJSON, "json", false, "emit the action list as JSON")
	planCmd.Flags().StringVar(&planVenv, "venv", "", "render into the named venv (engine=local)")
	planCmd.Flags().StringVar(&planMaterialize, "materialize", "", "re-render the named venv's chart globally")
	planCmd.Flags().StringVarP(&planValues, "values", "f", "", "CUE values file unified into the chart")
}

func firstArg(args []string) string {
	if len(args) > 0 {
		return args[0]
	}
	return ""
}

// printPlan renders a terraform-style summary of the plan.
func printPlan(p state.Plan) {
	for _, a := range p.Actions {
		fmt.Printf("  %s %-12s %s\n", marker(a.Kind), a.StateName, a.Summary)
	}
	if len(p.Actions) == 0 {
		fmt.Printf("No changes. %d state(s) already up to date.\n", p.Unchanged)
		return
	}
	fmt.Printf("\nPlan: %d to change, %d unchanged.\n", len(p.Actions), p.Unchanged)
}

// marker maps an action kind to a leading sigil for plan output.
func marker(kind string) string {
	switch kind {
	case "write-file", "set-env":
		return "~"
	case "run":
		return ">"
	default: // installs
		return "+"
	}
}

func printPlanJSON(p state.Plan) error {
	type actJSON struct {
		State   string `json:"state"`
		Kind    string `json:"kind"`
		Summary string `json:"summary"`
	}
	out := struct {
		Actions   []actJSON `json:"actions"`
		Unchanged int       `json:"unchanged"`
	}{Unchanged: p.Unchanged}
	for _, a := range p.Actions {
		out.Actions = append(out.Actions, actJSON{State: a.StateName, Kind: a.Kind, Summary: a.Summary})
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	return enc.Encode(out)
}
