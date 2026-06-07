package sys

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
)

// Result holds the captured output of a command.
type Result struct {
	Stdout   string
	Stderr   string
	ExitCode int
}

// Run executes a command, capturing stdout/stderr. A non-zero exit is NOT an
// error here — inspect Result.ExitCode. An error is returned only if the
// command could not be started (e.g. binary not found).
func Run(ctx context.Context, name string, args ...string) (Result, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	var out, errb bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &errb
	err := cmd.Run()
	res := Result{Stdout: out.String(), Stderr: errb.String()}
	if err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			res.ExitCode = ee.ExitCode()
			return res, nil
		}
		return res, fmt.Errorf("%s: %w", name, err)
	}
	return res, nil
}

// Stream runs a command with stdio inherited from the current process, so its
// output is shown live. Used by apply for shell/npm actions.
func Stream(ctx context.Context, name string, args ...string) error {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Stdin = os.Stdin
	return cmd.Run()
}

// Look reports whether a binary is resolvable on PATH.
func Look(name string) bool {
	_, err := exec.LookPath(name)
	return err == nil
}
