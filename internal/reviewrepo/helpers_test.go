// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package reviewrepo

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/KonghaYao/open-code-review/internal/reviewcore"
)

// testRepo is a throwaway git repository. Identity and dates are pinned so a
// failing test can be reproduced; the environment is isolated from any global
// git configuration on the machine.
type testRepo struct {
	t   *testing.T
	dir string
}

func newTestRepo(t *testing.T) *testRepo {
	t.Helper()
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("GIT_AUTHOR_NAME", "test")
	t.Setenv("GIT_AUTHOR_EMAIL", "test@example.com")
	t.Setenv("GIT_COMMITTER_NAME", "test")
	t.Setenv("GIT_COMMITTER_EMAIL", "test@example.com")
	t.Setenv("GIT_AUTHOR_DATE", "2026-01-01T00:00:00Z")
	t.Setenv("GIT_COMMITTER_DATE", "2026-01-01T00:00:00Z")

	repo := &testRepo{t: t, dir: t.TempDir()}
	repo.git("init", "-q", "-b", "main")
	return repo
}

func (r *testRepo) git(args ...string) string {
	r.t.Helper()
	out, err := r.tryGit(args...)
	if err != nil {
		r.t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return out
}

func (r *testRepo) tryGit(args ...string) (string, error) {
	r.t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = r.dir
	out, err := cmd.CombinedOutput()
	return string(out), err
}

func (r *testRepo) write(path, content string) {
	r.t.Helper()
	r.writeBytes(path, []byte(content))
}

func (r *testRepo) writeBytes(path string, data []byte) {
	r.t.Helper()
	full := filepath.Join(r.dir, filepath.FromSlash(path))
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		r.t.Fatalf("create directory for %s: %v", path, err)
	}
	if err := os.WriteFile(full, data, 0o644); err != nil {
		r.t.Fatalf("write %s: %v", path, err)
	}
}

func (r *testRepo) remove(path string) {
	r.t.Helper()
	if err := os.Remove(filepath.Join(r.dir, filepath.FromSlash(path))); err != nil {
		r.t.Fatalf("remove %s: %v", path, err)
	}
}

func (r *testRepo) commit(message string) string {
	r.t.Helper()
	r.git("add", "-A")
	r.git("commit", "-q", "-m", message)
	return r.head()
}

func (r *testRepo) head() string {
	r.t.Helper()
	out, err := r.tryGit("rev-parse", "HEAD")
	if err != nil {
		r.t.Fatalf("rev-parse HEAD: %v\n%s", err, out)
	}
	return trimNewline(out)
}

// newRepo builds the adapter with a state directory outside the worktree.
func (r *testRepo) newRepo(opts Options) *Repo {
	r.t.Helper()
	repo, err := New(r.dir, r.t.TempDir(), opts)
	if err != nil {
		r.t.Fatalf("New: %v", err)
	}
	return repo
}

func trimNewline(value string) string {
	for len(value) > 0 && (value[len(value)-1] == '\n' || value[len(value)-1] == '\r') {
		value = value[:len(value)-1]
	}
	return value
}

func prepareInput(t *testing.T, repo *Repo, input reviewcore.InputSpec) *reviewcore.Snapshot {
	t.Helper()
	snapshot, err := repo.Prepare(context.Background(), input, reviewcore.Scope{})
	if err != nil {
		t.Fatalf("Prepare(%+v): %v", input, err)
	}
	return snapshot
}

func findChange(t *testing.T, snapshot *reviewcore.Snapshot, path string) reviewcore.Change {
	t.Helper()
	for _, change := range snapshot.Changes {
		if change.EffectivePath() == path {
			return change
		}
	}
	t.Fatalf("change for %s not found in %v", path, changePaths(snapshot))
	return reviewcore.Change{}
}

func changePaths(snapshot *reviewcore.Snapshot) []string {
	paths := make([]string, 0, len(snapshot.Changes))
	for _, change := range snapshot.Changes {
		paths = append(paths, change.EffectivePath())
	}
	return paths
}

func hasFile(snapshot *reviewcore.Snapshot, side, path string) bool {
	for _, record := range snapshot.Files {
		if record.Side == side && record.Path == path {
			return true
		}
	}
	return false
}

func excludedEntry(snapshot *reviewcore.Snapshot, path, reason string) *reviewcore.ExcludedEntry {
	for i := range snapshot.Excluded {
		if snapshot.Excluded[i].Path == path && snapshot.Excluded[i].Reason == reason {
			return &snapshot.Excluded[i]
		}
	}
	return nil
}

func mustOpen(t *testing.T, repo *Repo, snapshot *reviewcore.Snapshot) reviewcore.Reader {
	t.Helper()
	reader, err := repo.Open(snapshot)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	return reader
}

func mustReadFile(t *testing.T, reader reviewcore.Reader, path, side string) reviewcore.FileContent {
	t.Helper()
	content, err := reader.ReadFile(context.Background(), path, side)
	if err != nil {
		t.Fatalf("ReadFile(%s, %s): %v", path, side, err)
	}
	return content
}

func requireCode(t *testing.T, err error, code reviewcore.ErrorCode) {
	t.Helper()
	if err == nil {
		t.Fatalf("expected %s, got nil", code)
	}
	if !reviewcore.IsCode(err, code) {
		t.Fatalf("expected %s, got %v", code, err)
	}
}
