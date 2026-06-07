package cmd

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/coffeectx/coffeeenv/internal/state"
	"github.com/coffeectx/coffeeenv/internal/venv"
)

var (
	autoApprove      bool
	applyVenv        string
	applyMaterialize string
	applyValues      string
)

var applyCmd = &cobra.Command{
	Use:   "apply [chart]",
	Short: "Converge the chart's states",
	Long: `Render a chart and apply the actions needed to converge.

Modes:
  apply [chart]              against the real system (engine=global)
  apply --venv <name> <chart>   install into a local venv (engine=local)
  apply --materialize <name>    re-render the venv's chart against the real system`,
	Args: cobra.MaximumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		t, err := resolveTarget(firstArg(args), applyVenv, applyMaterialize, applyValues)
		if err != nil {
			return err
		}
		p, err := computePlan(cmd.Context(), t)
		if err != nil {
			return err
		}

		fmt.Printf("Target: %s\n", t.label)
		if len(p.Actions) == 0 {
			fmt.Printf("Nothing to do. %d state(s) already up to date.\n", p.Unchanged)
			return nil
		}

		printPlan(p)
		if !autoApprove {
			ok, err := confirm("\nApply these changes?")
			if err != nil {
				return err
			}
			if !ok {
				fmt.Println("Aborted.")
				return nil
			}
		}

		fmt.Println()
		if err := (state.Engine{}).Apply(cmd.Context(), p); err != nil {
			return err
		}
		fmt.Printf("\nApplied %d change(s).\n", len(p.Actions))

		if t.venv != nil {
			if err := recordManifest(*t.venv, t); err != nil {
				return fmt.Errorf("record venv manifest: %w", err)
			}
		}
		printEnvHintIfNeeded(t, p)
		return nil
	},
}

func init() {
	applyCmd.Flags().BoolVar(&autoApprove, "auto-approve", false, "apply without prompting")
	applyCmd.Flags().StringVar(&applyVenv, "venv", "", "install into the named venv (engine=local)")
	applyCmd.Flags().StringVar(&applyMaterialize, "materialize", "", "re-render the named venv's chart globally")
	applyCmd.Flags().StringVarP(&applyValues, "values", "f", "", "CUE values file unified into the chart")
}

// recordManifest writes which chart+values were rendered into the venv.
func recordManifest(v venv.Venv, t target) error {
	values := t.opts.ValuesFile
	if values != "" {
		if abs, err := filepath.Abs(values); err == nil {
			values = abs
		}
	}
	return v.WriteManifest(venv.Manifest{
		Name:       v.Name,
		Chart:      t.chartName,
		ValuesFile: values,
		Engine:     "local",
		BuiltAt:    time.Now().UTC().Format(time.RFC3339),
	})
}

// confirm prompts for a y/N answer on stdin.
func confirm(prompt string) (bool, error) {
	fmt.Printf("%s [y/N] ", prompt)
	sc := bufio.NewScanner(os.Stdin)
	if !sc.Scan() {
		return false, sc.Err()
	}
	ans := strings.ToLower(strings.TrimSpace(sc.Text()))
	return ans == "y" || ans == "yes", nil
}

// printEnvHintIfNeeded reminds the user how to load env vars that were set.
func printEnvHintIfNeeded(t target, p state.Plan) {
	for _, a := range p.Actions {
		if a.Kind != "set-env" {
			continue
		}
		if t.venv != nil {
			fmt.Printf("\nEnv vars written to the venv. Activate with:\n  coffeeenv venv shell %s\n", t.venv.Name)
		} else {
			fmt.Println("\nEnv vars updated. Add this to your shell rc if you haven't:")
			fmt.Println("  source ~/.config/coffeeenv/activate.sh")
		}
		return
	}
}
