package chart

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/coffeectx/coffeeenv/internal/sys"
)

// Pull fetches the environment definition at source (a local directory or a
// git+https URL) into the chart directory, wiping any previous contents. It
// returns the ref/commit for the lock file (empty for local sources).
func (c Chart) Pull(ctx context.Context, source string) (ref, commit string, err error) {
	var srcDir string
	var cleanup func()

	if isGitSource(source) {
		srcDir, ref, commit, cleanup, err = fetchGit(ctx, source)
		if err != nil {
			return "", "", err
		}
		defer cleanup()
	} else {
		srcDir, err = filepath.Abs(source)
		if err != nil {
			return "", "", err
		}
		if fi, statErr := os.Stat(srcDir); statErr != nil || !fi.IsDir() {
			return "", "", fmt.Errorf("source %q is not a directory", source)
		}
	}

	if !hasCueFile(srcDir) {
		return "", "", fmt.Errorf("source %q contains no .cue files", source)
	}

	if err := os.RemoveAll(c.Dir); err != nil {
		return "", "", err
	}
	if err := copyTree(srcDir, c.Dir); err != nil {
		return "", "", err
	}
	if err := c.ensureModule(); err != nil {
		return "", "", err
	}
	return ref, commit, nil
}

// ensureModule writes cue.mod/module.cue if the pulled source didn't ship one.
func (c Chart) ensureModule() error {
	if _, err := os.Stat(c.CueModule()); err == nil {
		return nil
	}
	const mod = "module: \"coffeeenv.dev/user\"\nlanguage: version: \"v0.9.0\"\n"
	return sys.WriteFileAtomic(c.CueModule(), []byte(mod), 0o644)
}

func isGitSource(s string) bool {
	return strings.HasPrefix(s, "git+") ||
		strings.HasPrefix(s, "git@") ||
		strings.HasSuffix(strings.SplitN(s, "#", 2)[0], ".git")
}

// fetchGit clones a git+https URL of the form
//
//	git+https://host/user/repo.git#ref:subpath
//
// (ref and subpath optional) into a temp dir and returns the effective source
// directory (the subpath if given), the ref, and the resolved commit.
func fetchGit(ctx context.Context, source string) (dir, ref, commit string, cleanup func(), err error) {
	url := strings.TrimPrefix(source, "git+")
	var subpath string
	if i := strings.Index(url, "#"); i >= 0 {
		frag := url[i+1:]
		url = url[:i]
		if j := strings.Index(frag, ":"); j >= 0 {
			ref, subpath = frag[:j], frag[j+1:]
		} else {
			ref = frag
		}
	}

	tmp, err := os.MkdirTemp("", "coffeeenv-pull-*")
	if err != nil {
		return "", "", "", func() {}, err
	}
	cleanup = func() { os.RemoveAll(tmp) }

	args := []string{"clone", "--depth", "1"}
	if ref != "" {
		args = append(args, "--branch", ref)
	}
	args = append(args, url, tmp)
	if cloneErr := sys.Stream(ctx, "git", args...); cloneErr != nil {
		cleanup()
		return "", "", "", func() {}, fmt.Errorf("git clone: %w", cloneErr)
	}

	if res, revErr := sys.Run(ctx, "git", "-C", tmp, "rev-parse", "HEAD"); revErr == nil {
		commit = strings.TrimSpace(res.Stdout)
	}

	dir = tmp
	if subpath != "" {
		dir = filepath.Join(tmp, subpath)
		if fi, statErr := os.Stat(dir); statErr != nil || !fi.IsDir() {
			cleanup()
			return "", "", "", func() {}, fmt.Errorf("subpath %q not found in repo", subpath)
		}
	}
	return dir, ref, commit, cleanup, nil
}

// hasCueFile reports whether dir contains at least one .cue file (recursively,
// skipping the excluded dirs).
func hasCueFile(dir string) bool {
	found := false
	filepath.WalkDir(dir, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() && excluded(d.Name()) && p != dir {
			return filepath.SkipDir
		}
		if !d.IsDir() && strings.HasSuffix(d.Name(), ".cue") {
			found = true
			return filepath.SkipAll
		}
		return nil
	})
	return found
}

func excluded(name string) bool { return name == ".git" || name == "node_modules" }

// copyTree recursively copies src into dst, preserving file modes and skipping
// excluded directories.
func copyTree(src, dst string) error {
	return filepath.WalkDir(src, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, p)
		if err != nil {
			return err
		}
		if d.IsDir() {
			if excluded(d.Name()) && p != src {
				return filepath.SkipDir
			}
			return os.MkdirAll(filepath.Join(dst, rel), 0o755)
		}
		return copyFile(p, filepath.Join(dst, rel))
	})
}

func copyFile(src, dst string) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	info, err := in.Stat()
	if err != nil {
		return err
	}
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, info.Mode().Perm())
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, in)
	return err
}
