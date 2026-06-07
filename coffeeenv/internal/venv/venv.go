// Package venv manages local environments: a directory into which a chart is
// installed under the local engine, with a manifest recording which chart and
// values were rendered, plus an activate script for `venv shell`.
package venv

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"

	"github.com/coffeectx/coffeeenv/internal/sys"
)

// Venv is a local environment directory.
type Venv struct {
	Name string
	Dir  string
}

// Root returns the directory holding all venvs (~/.coffeeenv/venv), honoring
// $COFFEEENV_ROOT.
func Root() (string, error) {
	root := os.Getenv("COFFEEENV_ROOT")
	if root == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		root = filepath.Join(home, ".coffeeenv")
	}
	return filepath.Join(root, "venv"), nil
}

// Open returns the venv with the given name (it need not exist yet).
func Open(name string) (Venv, error) {
	root, err := Root()
	if err != nil {
		return Venv{}, err
	}
	return Venv{Name: name, Dir: filepath.Join(root, name)}, nil
}

// List returns the names of all venvs.
func List() ([]string, error) {
	root, err := Root()
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var names []string
	for _, e := range entries {
		if e.IsDir() {
			names = append(names, e.Name())
		}
	}
	return names, nil
}

func (v Venv) Bin() string          { return filepath.Join(v.Dir, "bin") }
func (v Venv) Activate() string     { return filepath.Join(v.Dir, "activate.sh") }
func (v Venv) EnvFile() string      { return filepath.Join(v.Dir, "env.sh") }
func (v Venv) ManifestPath() string { return filepath.Join(v.Dir, "manifest.json") }

// Exists reports whether the venv directory is present.
func (v Venv) Exists() bool {
	_, err := os.Stat(v.Dir)
	return err == nil
}

// Manifest records which chart and values were rendered into the venv.
type Manifest struct {
	Name    string            `json:"name"`
	Chart   string            `json:"chart,omitempty"`
	Values  map[string]string `json:"values,omitempty"`
	Engine  string            `json:"engine"`
	BuiltAt string            `json:"builtAt,omitempty"`
}

// Create initializes an empty venv: directories, an activate script, and an
// empty manifest.
func (v Venv) Create() error {
	if v.Exists() {
		return fmt.Errorf("venv %q already exists at %s", v.Name, v.Dir)
	}
	if err := os.MkdirAll(v.Bin(), 0o755); err != nil {
		return err
	}
	if err := sys.WriteFileAtomic(v.Activate(), []byte(v.activateScript()), 0o644); err != nil {
		return err
	}
	return v.WriteManifest(Manifest{Name: v.Name, Engine: "local"})
}

// activateScript prepends the venv's bin to PATH and sources the env-state file.
func (v Venv) activateScript() string {
	return fmt.Sprintf(`# coffeeenv venv %q — source this to activate.
export COFFEEENV_VENV=%q
export PATH=%q:"$PATH"
[ -f %q ] && . %q
`, v.Name, v.Name, v.Bin(), v.EnvFile(), v.EnvFile())
}

// ReadManifest loads the venv's manifest.
func (v Venv) ReadManifest() (Manifest, error) {
	b, err := os.ReadFile(v.ManifestPath())
	if err != nil {
		return Manifest{}, err
	}
	var m Manifest
	if err := json.Unmarshal(b, &m); err != nil {
		return Manifest{}, err
	}
	return m, nil
}

// WriteManifest persists the venv's manifest.
func (v Venv) WriteManifest(m Manifest) error {
	b, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	return sys.WriteFileAtomic(v.ManifestPath(), append(b, '\n'), 0o644)
}

// Shell spawns an interactive subshell with the venv activated.
func (v Venv) Shell(ctx context.Context) error {
	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/sh"
	}
	script := fmt.Sprintf(". %q; exec %q", v.Activate(), shell)
	cmd := exec.CommandContext(ctx, "sh", "-c", script)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}
