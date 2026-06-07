package cuelib

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/coffeectx/coffeeenv/internal/state"
)

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func exampleDir() string {
	_, thisFile, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(thisFile), "..", "..", "examples", "claude-basic")
}

func byName(raws []state.RawState) map[string]state.RawState {
	m := map[string]state.RawState{}
	for _, r := range raws {
		m[r.Name] = r
	}
	return m
}

// TestEvalStatesGlobal is the regression guard for the CUE overlay/import wiring
// under the global engine.
func TestEvalStatesGlobal(t *testing.T) {
	raws, err := EvalStates(exampleDir(), Opts{Engine: "global", Root: "~"})
	if err != nil {
		t.Fatalf("EvalStates: %v", err)
	}
	want := []struct{ typ, name string }{
		{"npm", "claude-code"},
		{"file", "claude-claudemd"},
		{"file", "claude-settings"},
		{"file", "claude-mcp"},
		{"env", "EDITOR"},
		{"file", "marker"},
	}
	if len(raws) != len(want) {
		t.Fatalf("got %d states, want %d: %+v", len(raws), len(want), raws)
	}
	for i, w := range want {
		if raws[i].Type != w.typ || raws[i].Name != w.name {
			t.Errorf("state[%d] = {%s %s}, want {%s %s}", i, raws[i].Type, raws[i].Name, w.typ, w.name)
		}
	}
	m := byName(raws)
	if got := m["claude-code"].Params["prefix"]; got != nil && got != "" {
		t.Errorf("global npm should have no prefix, got %v", got)
	}
	if got := m["claude-settings"].Params["path"]; got != "~/.claude/settings.json" {
		t.Errorf("global settings path = %v", got)
	}
}

// TestEvalStatesLocal asserts the same chart renders venv-scoped paths, a npm
// prefix, and the CLAUDE_CONFIG_DIR env wiring under the local engine.
func TestEvalStatesLocal(t *testing.T) {
	root := "/tmp/coffeeenv-venv-test"
	raws, err := EvalStates(exampleDir(), Opts{Engine: "local", Root: root})
	if err != nil {
		t.Fatalf("EvalStates: %v", err)
	}
	m := byName(raws)

	if got := m["claude-code"].Params["prefix"]; got != root {
		t.Errorf("local npm prefix = %v, want %v", got, root)
	}
	if got, _ := m["claude-settings"].Params["path"].(string); !strings.HasPrefix(got, root+"/.claude") {
		t.Errorf("local settings path = %v, want under %s", got, root)
	}
	cc, ok := m["CLAUDE_CONFIG_DIR"]
	if !ok {
		t.Fatalf("local engine should emit CLAUDE_CONFIG_DIR env state; states: %v", raws)
	}
	if got := cc.Params["value"]; got != root+"/.claude" {
		t.Errorf("CLAUDE_CONFIG_DIR value = %v", got)
	}
	if got := cc.Params["target"]; got != root+"/env.sh" {
		t.Errorf("CLAUDE_CONFIG_DIR target = %v", got)
	}
}

// TestRequireRefusesEngine verifies a chart can refuse an engine via context.#Require.
func TestRequireRefusesEngine(t *testing.T) {
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "env.cue"), `package env
import (
	"coffeeenv.dev/lib/context"
	st "coffeeenv.dev/lib/states"
)
_req: context.#Require & {engines: ["global"]}
states: [st.#FileState & {name: "x", path: "/tmp/x", content: "y"}]
`)
	if _, err := EvalStates(dir, Opts{Engine: "global", Root: "~"}); err != nil {
		t.Fatalf("global should be allowed: %v", err)
	}
	if _, err := EvalStates(dir, Opts{Engine: "local", Root: "/tmp/v"}); err == nil {
		t.Fatalf("local should be refused by context.#Require")
	}
}
