// Package chart manages the local directory where pulled environment
// definitions ("charts") live: a chart is a CUE definition plus a cue.mod marker
// and a lock file recording where it came from.
package chart

import (
	"encoding/json"
	"os"
	"path/filepath"

	"github.com/coffeectx/coffeeenv/internal/sys"
)

// Chart is a pulled environment definition on disk.
type Chart struct {
	Name string
	Dir  string
}

// Root returns the directory holding all charts (~/.coffeeenv/charts), honoring
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
	return filepath.Join(root, "charts"), nil
}

// Open returns the chart with the given name (it need not exist yet).
func Open(name string) (Chart, error) {
	root, err := Root()
	if err != nil {
		return Chart{}, err
	}
	return Chart{Name: name, Dir: filepath.Join(root, name)}, nil
}

// List returns the names of all pulled charts.
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

// CueModule is the path to the chart's module marker.
func (c Chart) CueModule() string { return filepath.Join(c.Dir, "cue.mod", "module.cue") }

// Lock is the path to the chart's lock file.
func (c Chart) Lock() string { return filepath.Join(c.Dir, "coffeeenv.lock.json") }

// LockInfo records the provenance of a pulled chart.
type LockInfo struct {
	Source   string `json:"source"`
	Ref      string `json:"ref,omitempty"`
	Commit   string `json:"commit,omitempty"`
	PulledAt string `json:"pulledAt"`
}

// WriteLock persists the lock file.
func (c Chart) WriteLock(info LockInfo) error {
	b, err := json.MarshalIndent(info, "", "  ")
	if err != nil {
		return err
	}
	return sys.WriteFileAtomic(c.Lock(), append(b, '\n'), 0o644)
}

// ReadLock loads the lock file, if present.
func (c Chart) ReadLock() (LockInfo, bool, error) {
	b, err := os.ReadFile(c.Lock())
	if err != nil {
		if os.IsNotExist(err) {
			return LockInfo{}, false, nil
		}
		return LockInfo{}, false, err
	}
	var info LockInfo
	if err := json.Unmarshal(b, &info); err != nil {
		return LockInfo{}, false, err
	}
	return info, true, nil
}

// Exists reports whether the chart directory is populated.
func (c Chart) Exists() bool {
	_, err := os.Stat(c.Dir)
	return err == nil
}
