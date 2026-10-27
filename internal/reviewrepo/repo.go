// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

// Package reviewrepo freezes one git repository state into a reviewcore
// snapshot and serves immutable reads from that snapshot. Nothing here mutates
// the repository and nothing reads the worktree after Prepare returns.
package reviewrepo

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/KonghaYao/open-code-review/internal/gitcmd"
	"github.com/KonghaYao/open-code-review/internal/reviewcore"
)

const (
	defaultMaxDiffBytes = 4 << 20
	defaultMaxFileBytes = 2 << 20
	defaultGitJobs      = 8

	// emptyTreeSHA is git's well-known empty tree. diff and ls-tree resolve it
	// even when the object is absent from the repository database, which is what
	// makes it safe for root commits.
	emptyTreeSHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"

	snapshotsDirName = "snapshots"
	snapshotFileName = "snapshot.json"
	newSideDirName   = "new"
)

// Options bounds snapshot collection and reads. The zero value is valid.
type Options struct {
	// MaxDiffBytes caps the stored diff text of a single change. Longer blocks
	// are cut on a line boundary and marked truncated.
	MaxDiffBytes int
	// MaxFileBytes caps what is copied into a snapshot and what reads and
	// searches will load. Larger files stay in the manifest as TooLarge.
	MaxFileBytes int
	// Runner bounds concurrent git subprocesses. A private runner is created
	// when nil.
	Runner *gitcmd.Runner
	// Now stamps snapshots; tests substitute a fixed clock.
	Now func() time.Time
}

func (o Options) withDefaults() Options {
	if o.MaxDiffBytes <= 0 {
		o.MaxDiffBytes = defaultMaxDiffBytes
	}
	if o.MaxFileBytes <= 0 {
		o.MaxFileBytes = defaultMaxFileBytes
	}
	if o.Runner == nil {
		o.Runner = gitcmd.New(defaultGitJobs)
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	return o
}

// Repo binds one repository root and the state directory that holds frozen
// workspace copies.
type Repo struct {
	root     string
	stateDir string
	opts     Options
}

var _ reviewcore.Repository = (*Repo)(nil)

// New resolves the repository root and validates that stateDir lives outside
// it. The git top-level, not the caller's directory, becomes the bound root so
// that paths in snapshots are always repository-relative.
func New(root, stateDir string, opts Options) (*Repo, error) {
	opts = opts.withDefaults()

	if strings.TrimSpace(root) == "" {
		return nil, reviewcore.Errorf(reviewcore.CodeInvalidInput, "repository root is required")
	}
	if strings.TrimSpace(stateDir) == "" {
		return nil, reviewcore.Errorf(reviewcore.CodeInvalidInput, "state directory is required")
	}

	canonicalRoot, err := canonicalPath(root)
	if err != nil {
		return nil, reviewcore.Errorf(reviewcore.CodeInvalidInput, "resolve repository root: %v", err)
	}
	info, err := os.Stat(canonicalRoot)
	if err != nil || !info.IsDir() {
		return nil, reviewcore.Errorf(reviewcore.CodeInvalidInput, "repository root is not a readable directory")
	}

	repo := &Repo{root: canonicalRoot, opts: opts}
	// New has no caller context; the probe is a single fast git call.
	top, err := repo.gitText(context.Background(), "rev-parse", "--show-toplevel")
	if err != nil {
		return nil, err
	}
	top = strings.TrimSpace(top)
	if top == "" {
		return nil, reviewcore.Errorf(reviewcore.CodeGitFailure, "git reported an empty repository root")
	}
	realTop, err := canonicalPath(top)
	if err != nil {
		return nil, reviewcore.Errorf(reviewcore.CodeGitFailure, "resolve git top-level: %v", err)
	}
	repo.root = realTop

	canonicalState, err := canonicalPath(stateDir)
	if err != nil {
		return nil, reviewcore.Errorf(reviewcore.CodeInvalidInput, "resolve state directory: %v", err)
	}
	if within(realTop, canonicalState) {
		// A snapshot under the worktree would make the review input mutable and
		// would leak frozen secret-free copies into git status.
		return nil, reviewcore.Errorf(reviewcore.CodeInvalidInput, "state directory must be outside the repository")
	}
	repo.stateDir = canonicalState
	if err := os.MkdirAll(filepath.Join(canonicalState, snapshotsDirName), 0o700); err != nil {
		return nil, reviewcore.Errorf(reviewcore.CodePreparationFailed, "create state directory: %v", err)
	}
	return repo, nil
}

func gitGlobalArgs() []string {
	// --no-optional-locks keeps read-only commands from refreshing the index;
	// quotepath=false keeps non-ASCII paths literal so they match tree entries.
	return []string{"--no-optional-locks", "-c", "core.quotepath=false"}
}

func (r *Repo) git(ctx context.Context, args ...string) ([]byte, error) {
	out, stderr, err := r.opts.Runner.RunSplit(ctx, r.root, append(gitGlobalArgs(), args...)...)
	if err != nil {
		return nil, r.gitError(args, stderr, err, ctx.Err())
	}
	return []byte(out), nil
}

func (r *Repo) gitText(ctx context.Context, args ...string) (string, error) {
	out, err := r.git(ctx, args...)
	if err != nil {
		return "", err
	}
	return string(out), nil
}

// gitError maps a subprocess failure to a business error without exposing
// repository paths, which the transport must never leak to a client.
func (r *Repo) gitError(args []string, stderr string, err error, ctxErr error) error {
	message := strings.TrimSpace(stderr)
	if message == "" && err != nil {
		message = err.Error()
	}
	if ctxErr != nil {
		message = ctxErr.Error()
	}
	message = strings.ReplaceAll(message, r.root, "<repo>")
	if r.stateDir != "" {
		message = strings.ReplaceAll(message, r.stateDir, "<state>")
	}
	message = strings.Join(strings.Fields(message), " ")
	if len(message) > 300 {
		message = message[:300]
	}
	command := "<unknown>"
	for _, arg := range args {
		if !strings.HasPrefix(arg, "-") {
			command = arg
			break
		}
	}
	if message == "" {
		return reviewcore.Errorf(reviewcore.CodeGitFailure, "git %s failed", command)
	}
	return reviewcore.Errorf(reviewcore.CodeGitFailure, "git %s failed: %s", command, message)
}

func (r *Repo) snapshotDir(id string) string {
	return filepath.Join(r.stateDir, snapshotsDirName, id)
}

// copyName is the on-disk name of a frozen worktree file. Hashing the path
// keeps hostile names (slashes, "..", newlines) out of the filesystem layout.
func copyName(path string) string {
	sum := sha256.Sum256([]byte(path))
	return hex.EncodeToString(sum[:])
}

// canonicalPath resolves symlinks for the longest existing prefix and appends
// the missing suffix back. The state directory usually does not exist yet, and
// comparing an unresolved path against a resolved git root would be wrong on
// platforms where the temporary root itself is a symlink.
func canonicalPath(path string) (string, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	abs = filepath.Clean(abs)
	suffix := ""
	current := abs
	for {
		resolved, resolveErr := filepath.EvalSymlinks(current)
		if resolveErr == nil {
			if suffix == "" {
				return resolved, nil
			}
			return filepath.Join(resolved, suffix), nil
		}
		if !errors.Is(resolveErr, os.ErrNotExist) {
			return "", resolveErr
		}
		parent := filepath.Dir(current)
		if parent == current {
			return abs, nil
		}
		suffix = filepath.Join(filepath.Base(current), suffix)
		current = parent
	}
}

func within(base, target string) bool {
	if base == "" {
		return false
	}
	if target == base {
		return true
	}
	return strings.HasPrefix(target, base+string(os.PathSeparator))
}

// atomicWriteFile replaces path without ever exposing a partial file to a
// concurrent Open.
func atomicWriteFile(path string, data []byte) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".tmp-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmpName, 0o644); err != nil {
		return err
	}
	return os.Rename(tmpName, path)
}

func marshalSnapshot(snapshot *reviewcore.Snapshot) ([]byte, error) {
	data, err := json.MarshalIndent(snapshot, "", "  ")
	if err != nil {
		return nil, reviewcore.Errorf(reviewcore.CodePreparationFailed, "encode snapshot: %v", err)
	}
	return append(data, '\n'), nil
}
