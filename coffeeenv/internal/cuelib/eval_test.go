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

func exampleDir(name string) string {
	_, thisFile, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(thisFile), "..", "..", "examples", name)
}

func byName(raws []state.RawState) map[string]state.RawState {
	m := map[string]state.RawState{}
	for _, r := range raws {
		m[r.Name] = r
	}
	return m
}

// TestClaudeGlobal is the regression guard for the polymorphic framework + the
// CUE overlay/import wiring under the global engine.
func TestClaudeGlobal(t *testing.T) {
	raws, err := EvalStates(exampleDir("claude-basic"), Opts{Engine: "global", Root: "~"})
	if err != nil {
		t.Fatalf("EvalStates: %v", err)
	}
	m := byName(raws)
	for _, n := range []string{"claude-code", "claude-claudemd", "claude-skill-hello", "claude-mcp"} {
		if _, ok := m[n]; !ok {
			t.Errorf("missing state %q; got %v", n, names(raws))
		}
	}
	if got := m["claude-code"].Params["prefix"]; got != nil && got != "" {
		t.Errorf("global npm should have no prefix, got %v", got)
	}
	if got, _ := m["claude-claudemd"].Params["path"].(string); got != "~/.claude/CLAUDE.md" {
		t.Errorf("CLAUDE.md path = %v", got)
	}
	if got, _ := m["claude-claudemd"].Params["content"].(string); !strings.Contains(got, "# Project") {
		t.Errorf("CLAUDE.md content = %q, want the agentMd part", got)
	}
	if got := m["claude-mcp"].Params["format"]; got != "json" {
		t.Errorf("claude-mcp format = %v, want json", got)
	}
	if _, ok := m["claude-mcp"].Params["data"].(map[string]any); !ok {
		t.Errorf("claude-mcp should carry a data subtree, got %#v", m["claude-mcp"].Params["data"])
	}
}

// TestClaudeLocal asserts venv-scoped paths, the npm prefix, and CLAUDE_CONFIG_DIR.
func TestClaudeLocal(t *testing.T) {
	root := "/tmp/coffeeenv-venv-test"
	raws, err := EvalStates(exampleDir("claude-basic"), Opts{Engine: "local", Root: root})
	if err != nil {
		t.Fatalf("EvalStates: %v", err)
	}
	m := byName(raws)
	if got := m["claude-code"].Params["prefix"]; got != root {
		t.Errorf("local npm prefix = %v, want %v", got, root)
	}
	if got, _ := m["claude-skill-hello"].Params["path"].(string); !strings.HasPrefix(got, root+"/.claude") {
		t.Errorf("local skill path = %v, want under %s", got, root)
	}
	cc, ok := m["CLAUDE_CONFIG_DIR"]
	if !ok {
		t.Fatalf("local engine should emit CLAUDE_CONFIG_DIR; got %v", names(raws))
	}
	if got := cc.Params["target"]; got != root+"/env.sh" {
		t.Errorf("CLAUDE_CONFIG_DIR target = %v", got)
	}
}

// TestCodexPolymorphic proves the same skill/MCP/agentMd features render into
// Codex's layout when the agent target is swapped.
func TestCodexPolymorphic(t *testing.T) {
	raws, err := EvalStates(exampleDir("codex-basic"), Opts{Engine: "global", Root: "~"})
	if err != nil {
		t.Fatalf("EvalStates: %v", err)
	}
	m := byName(raws)
	if _, ok := m["codex"]; !ok {
		t.Errorf("missing npm codex state; got %v", names(raws))
	}
	ag, ok := m["codex-agents"]
	if !ok {
		t.Fatalf("missing codex-agents; got %v", names(raws))
	}
	if got, _ := ag.Params["path"].(string); got != "~/.codex/AGENTS.md" {
		t.Errorf("AGENTS.md path = %v", got)
	}
	if got, _ := ag.Params["content"].(string); !strings.Contains(got, "## Skill: hello") || !strings.Contains(got, "# Project") {
		t.Errorf("AGENTS.md content missing skill section or agentMd part: %q", got)
	}
	mc, ok := m["codex-mcp"]
	if !ok {
		t.Fatalf("missing codex-mcp; got %v", names(raws))
	}
	if got := mc.Params["format"]; got != "toml" {
		t.Errorf("codex-mcp format = %v, want toml", got)
	}
}

// TestRenderAddsNodeModulesToPath: #Render emits an expandable PATH env state
// pointing at <root>/node_modules/.bin under the local engine, and none globally.
func TestRenderAddsNodeModulesToPath(t *testing.T) {
	g, err := EvalStates(exampleDir("claude-basic"), Opts{Engine: "global", Root: "~"})
	if err != nil {
		t.Fatalf("global: %v", err)
	}
	if _, ok := byName(g)["PATH"]; ok {
		t.Errorf("global engine should not add a PATH state")
	}

	root := "/tmp/coffeeenv-venv-test"
	l, err := EvalStates(exampleDir("claude-basic"), Opts{Engine: "local", Root: root})
	if err != nil {
		t.Fatalf("local: %v", err)
	}
	p, ok := byName(l)["PATH"]
	if !ok {
		t.Fatalf("local engine should add a PATH state; got %v", names(l))
	}
	if got := p.Params["value"]; got != root+"/node_modules/.bin:$PATH" {
		t.Errorf("PATH value = %v", got)
	}
	if p.Params["expand"] != true {
		t.Errorf("PATH state must be expand:true, got %v", p.Params["expand"])
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

func names(raws []state.RawState) []string {
	out := make([]string, len(raws))
	for i, r := range raws {
		out[i] = r.Name
	}
	return out
}
