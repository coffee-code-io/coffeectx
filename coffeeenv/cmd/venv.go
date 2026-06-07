package cmd

import (
	"fmt"

	"github.com/spf13/cobra"

	"github.com/coffeectx/coffeeenv/internal/venv"
)

var venvCmd = &cobra.Command{
	Use:   "venv",
	Short: "Manage local environments",
}

var venvCreateCmd = &cobra.Command{
	Use:   "create <name>",
	Short: "Create an empty local environment",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		v, err := venv.Open(args[0])
		if err != nil {
			return err
		}
		if err := v.Create(); err != nil {
			return err
		}
		fmt.Printf("Created venv %q at %s\n", v.Name, v.Dir)
		fmt.Printf("Next: coffeeenv apply --venv %s <chart>\n", v.Name)
		return nil
	},
}

var venvShellCmd = &cobra.Command{
	Use:   "shell <name>",
	Short: "Open a subshell with the venv activated",
	Args:  cobra.ExactArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		v, err := venv.Open(args[0])
		if err != nil {
			return err
		}
		if !v.Exists() {
			return fmt.Errorf("no venv %q", args[0])
		}
		return v.Shell(cmd.Context())
	},
}

var venvListCmd = &cobra.Command{
	Use:   "list",
	Short: "List local environments",
	Args:  cobra.NoArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		names, err := venv.List()
		if err != nil {
			return err
		}
		if len(names) == 0 {
			fmt.Println("No venvs. Create one with `coffeeenv venv create <name>`.")
			return nil
		}
		for _, n := range names {
			v, _ := venv.Open(n)
			chart := "(empty)"
			if m, err := v.ReadManifest(); err == nil && m.Chart != "" {
				chart = m.Chart
			}
			fmt.Printf("  %-20s %s\n", n, chart)
		}
		return nil
	},
}

func init() {
	venvCmd.AddCommand(venvCreateCmd, venvShellCmd, venvListCmd)
}
