package state

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"

	toml "github.com/pelletier/go-toml/v2"
	yaml "gopkg.in/yaml.v3"

	"github.com/coffeectx/coffeeenv/internal/sys"
)

func init() { Register(&fileHandler{}) }

type fileHandler struct{}

type fileDesired struct {
	Path    string         `json:"path"`
	Content *string        `json:"content"`
	Data    map[string]any `json:"data"`
	Format  string         `json:"format"`
	Mode    uint32         `json:"mode"`

	rendered []byte // final bytes, computed in Decode
}

type fileObserved struct {
	Exists  bool
	Hash    string
	Mode    os.FileMode
	AbsPath string
}

func (fileHandler) Type() string { return "file" }

func (fileHandler) Decode(rs RawState) (Desired, error) {
	var p fileDesired
	if err := decodeParams(rs, &p); err != nil {
		return nil, err
	}
	if p.Path == "" {
		return nil, errors.New("file: path is required")
	}
	if p.Mode == 0 {
		p.Mode = 0o644
	}

	switch {
	case p.Content != nil && p.Data != nil:
		return nil, errors.New("file: set either content or data, not both")
	case p.Content != nil:
		p.rendered = []byte(*p.Content)
	case p.Data != nil:
		b, err := renderData(p.Data, p.Format)
		if err != nil {
			return nil, fmt.Errorf("file %q: %w", p.Path, err)
		}
		p.rendered = b
	default:
		return nil, errors.New("file: content or data is required")
	}
	return &p, nil
}

// renderData marshals a structured subtree in the requested format. All formats
// must be deterministic (stable key order) so diffs are idempotent.
func renderData(data map[string]any, format string) ([]byte, error) {
	switch format {
	case "", "json":
		b, err := json.MarshalIndent(data, "", "  ") // map keys sorted
		if err != nil {
			return nil, err
		}
		return append(b, '\n'), nil
	case "toml":
		return toml.Marshal(data)
	case "yaml":
		return yaml.Marshal(data)
	default:
		return nil, fmt.Errorf("unknown format %q (want json, toml, or yaml)", format)
	}
}

func (fileHandler) Read(_ context.Context, desired Desired) (Observed, error) {
	d := desired.(*fileDesired)
	abs := sys.ExpandPath(d.Path)
	obs := &fileObserved{AbsPath: abs}
	b, err := os.ReadFile(abs)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return obs, nil
		}
		return nil, err
	}
	info, err := os.Stat(abs)
	if err != nil {
		return nil, err
	}
	obs.Exists = true
	obs.Hash = sys.HashBytes(b)
	obs.Mode = info.Mode().Perm()
	return obs, nil
}

func (fileHandler) Diff(desired Desired, observed Observed) ([]Action, error) {
	d := desired.(*fileDesired)
	o := observed.(*fileObserved)
	wantHash := sys.HashBytes(d.rendered)
	wantMode := os.FileMode(d.Mode)

	payload := filePayload{path: o.AbsPath, content: d.rendered, mode: wantMode}
	switch {
	case !o.Exists:
		return []Action{{StateName: d.Path, Kind: "write-file",
			Summary: fmt.Sprintf("create %s", o.AbsPath), Payload: payload}}, nil
	case o.Hash != wantHash:
		return []Action{{StateName: d.Path, Kind: "write-file",
			Summary: fmt.Sprintf("update %s (content differs)", o.AbsPath), Payload: payload}}, nil
	case o.Mode != wantMode:
		return []Action{{StateName: d.Path, Kind: "write-file",
			Summary: fmt.Sprintf("chmod %s %#o -> %#o", o.AbsPath, o.Mode, wantMode), Payload: payload}}, nil
	default:
		return nil, nil
	}
}

func (fileHandler) Apply(_ context.Context, a Action) error {
	p := a.Payload.(filePayload)
	return sys.WriteFileAtomic(p.path, p.content, p.mode)
}

type filePayload struct {
	path    string
	content []byte
	mode    os.FileMode
}
