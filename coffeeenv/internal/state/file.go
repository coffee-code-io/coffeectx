package state

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"

	"github.com/coffeectx/coffeeenv/internal/sys"
)

func init() { Register(&fileHandler{}) }

type fileHandler struct{}

type fileDesired struct {
	Path    string `json:"path"`
	Content string `json:"content"`
	Mode    uint32 `json:"mode"`
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
	return &p, nil
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
	wantHash := sys.HashBytes([]byte(d.Content))
	wantMode := os.FileMode(d.Mode)

	payload := filePayload{path: o.AbsPath, content: []byte(d.Content), mode: wantMode}
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
