package state

import (
	"strings"
	"testing"
)

func decodeFile(t *testing.T, params map[string]any) *fileDesired {
	t.Helper()
	d, err := fileHandler{}.Decode(RawState{Type: "file", Name: "f", Params: params})
	if err != nil {
		t.Fatalf("Decode: %v", err)
	}
	return d.(*fileDesired)
}

func TestFileRenderJSON(t *testing.T) {
	d := decodeFile(t, map[string]any{
		"path":   "/tmp/x.json",
		"format": "json",
		"data":   map[string]any{"b": 1, "a": 2},
	})
	got := string(d.rendered)
	// Keys must be sorted for a deterministic, idempotent diff.
	if strings.Index(got, `"a"`) > strings.Index(got, `"b"`) {
		t.Errorf("json keys not sorted: %s", got)
	}
}

func TestFileRenderTOML(t *testing.T) {
	d := decodeFile(t, map[string]any{
		"path":   "/tmp/x.toml",
		"format": "toml",
		"data":   map[string]any{"mcp_servers": map[string]any{"fs": map[string]any{"command": "npx"}}},
	})
	if got := string(d.rendered); !strings.Contains(got, "[mcp_servers.fs]") || !strings.Contains(got, "command = 'npx'") {
		t.Errorf("toml render = %q", got)
	}
}

func TestFileRenderDeterministic(t *testing.T) {
	params := map[string]any{
		"path":   "/tmp/x.toml",
		"format": "toml",
		"data":   map[string]any{"z": 1, "a": 2, "m": map[string]any{"k": "v", "j": "w"}},
	}
	a := decodeFile(t, params)
	b := decodeFile(t, params)
	if string(a.rendered) != string(b.rendered) {
		t.Errorf("toml render not deterministic:\n%s\n---\n%s", a.rendered, b.rendered)
	}
}

func TestEnvExpandRoundTrip(t *testing.T) {
	// An expand var renders double-quoted (so $PATH expands when sourced) and
	// reads back as the same value+mode (idempotent).
	v := envVar{Value: "/x/node_modules/.bin:$PATH", Expand: true}
	rendered := quoteShell(v)
	if rendered != `"/x/node_modules/.bin:$PATH"` {
		t.Fatalf("expand render = %s", rendered)
	}
	got, expand := unquoteShell(rendered)
	if got != v.Value || !expand {
		t.Errorf("round-trip = (%q, %v), want (%q, true)", got, expand, v.Value)
	}
	// A normal var stays single-quoted literal.
	if quoteShell(envVar{Value: "nvim"}) != `'nvim'` {
		t.Errorf("literal render = %s", quoteShell(envVar{Value: "nvim"}))
	}
}

func TestFileContentAndDataConflict(t *testing.T) {
	_, err := fileHandler{}.Decode(RawState{Type: "file", Name: "f", Params: map[string]any{
		"path": "/tmp/x", "content": "hi", "data": map[string]any{"a": 1},
	}})
	if err == nil {
		t.Fatal("expected error when both content and data are set")
	}
}
