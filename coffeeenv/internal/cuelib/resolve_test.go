package cuelib

import (
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func parametrizedDir() string {
	_, thisFile, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(thisFile), "..", "..", "examples", "parametrized")
}

// TestResolveWithFlags: values supplied up front resolve without prompting, and
// types are inferred (verbose is a bool).
func TestResolveWithFlags(t *testing.T) {
	r, err := Resolve(parametrizedDir(), Opts{Engine: "global", Root: "~"},
		map[string]string{"region": "us-east-1", "verbose": "true"}, nil)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if len(r.States) != 1 {
		t.Fatalf("got %d states, want 1: %+v", len(r.States), r.States)
	}
	if got, _ := r.States[0].Params["path"].(string); !strings.Contains(got, "us-east-1") {
		t.Errorf("path = %v, want it to contain region", got)
	}
	if got, _ := r.States[0].Params["content"].(string); !strings.Contains(got, "verbose=true") {
		t.Errorf("content = %q, want verbose=true (bool inference)", got)
	}
}

// TestResolveMissingNonInteractive: a nil PromptFunc errors and names every
// missing input.
func TestResolveMissingNonInteractive(t *testing.T) {
	_, err := Resolve(parametrizedDir(), Opts{Engine: "global", Root: "~"}, nil, nil)
	if err == nil {
		t.Fatal("expected an error for missing inputs")
	}
	for _, name := range []string{"region", "verbose"} {
		if !strings.Contains(err.Error(), name) {
			t.Errorf("error %q should mention %q", err.Error(), name)
		}
	}
}

// TestResolvePromptOrder: inputs are prompted lowest-order first and the chart
// resolves once they are supplied.
func TestResolvePromptOrder(t *testing.T) {
	var asked []string
	answers := map[string]string{"region": "eu-west-1", "verbose": "false"}
	prompt := func(in Input) (string, error) {
		asked = append(asked, in.Name)
		return answers[in.Name], nil
	}
	r, err := Resolve(parametrizedDir(), Opts{Engine: "global", Root: "~"}, nil, prompt)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if want := []string{"region", "verbose"}; strings.Join(asked, ",") != strings.Join(want, ",") {
		t.Errorf("ask order = %v, want %v (by order=)", asked, want)
	}
	if got, _ := r.States[0].Params["path"].(string); !strings.Contains(got, "eu-west-1") {
		t.Errorf("path = %v", got)
	}
}

// TestResolveNonAnnotatedError: a non-fixed top-level field without @input is an
// error (we cannot prompt for it).
func TestResolveNonAnnotatedError(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "env.cue"), `package env
import st "coffeeenv.dev/lib/states"
mystery: string   // non-concrete, no @input
states: [st.#FileState & {name: "x", path: "/tmp/x", content: mystery}]
`)
	_, err := Resolve(dir, Opts{Engine: "global", Root: "~"}, nil, nil)
	if err == nil || !strings.Contains(err.Error(), "mystery") {
		t.Fatalf("expected error naming `mystery`, got: %v", err)
	}
}
