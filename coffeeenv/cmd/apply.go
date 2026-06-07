package cmd

import (
	"bufio"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/coffeectx/coffeeenv/internal/cuelib"
	"github.com/coffeectx/coffeeenv/internal/state"
	"github.com/coffeectx/coffeeenv/internal/venv"
)

var (
	autoApprove      bool
	applyVenv        string
	applyMaterialize string
	applyValues      []string
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
		values, err := parseValues(applyValues)
		if err != nil {
			return err
		}
		t, err := resolveTarget(firstArg(args), applyVenv, applyMaterialize, values)
		if err != nil {
			return err
		}
		// apply prompts for unresolved inputs only on a TTY; otherwise a nil
		// PromptFunc errors listing the missing inputs. materialize never prompts.
		var prompt cuelib.PromptFunc
		if applyMaterialize == "" && stdinIsTTY() {
			prompt = interactivePrompt
		}

		p, resolvedValues, err := computePlan(cmd.Context(), t, prompt)
		if err != nil {
			return err
		}

		fmt.Printf("Target: %s\n", t.label)
		if len(p.Actions) == 0 {
			fmt.Printf("Nothing to do. %d state(s) already up to date.\n", p.Unchanged)
			if t.venv != nil {
				if err := recordManifest(*t.venv, t, resolvedValues); err != nil {
					return fmt.Errorf("record venv manifest: %w", err)
				}
			}
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
			if err := recordManifest(*t.venv, t, resolvedValues); err != nil {
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
	applyCmd.Flags().StringArrayVarP(&applyValues, "value", "V", nil, "set an input value: key=val (repeatable)")
}

// recordManifest writes which chart + resolved values were rendered into the venv.
func recordManifest(v venv.Venv, t target, values map[string]string) error {
	return v.WriteManifest(venv.Manifest{
		Name:    v.Name,
		Chart:   t.chartName,
		Values:  values,
		Engine:  "local",
		BuiltAt: time.Now().UTC().Format(time.RFC3339),
	})
}

// interactivePrompt asks the user for an input value on stdin.
func interactivePrompt(in cuelib.Input) (string, error) {
	fmt.Printf("%s ", in.Prompt)
	sc := bufio.NewScanner(os.Stdin)
	if !sc.Scan() {
		if err := sc.Err(); err != nil {
			return "", err
		}
		return "", fmt.Errorf("no input provided for %q", in.Name)
	}
	return strings.TrimSpace(sc.Text()), nil
}

// stdinIsTTY reports whether stdin is an interactive terminal.
func stdinIsTTY() bool {
	fi, err := os.Stdin.Stat()
	return err == nil && fi.Mode()&os.ModeCharDevice != 0
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
