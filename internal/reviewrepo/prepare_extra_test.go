// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package reviewrepo

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/KonghaYao/open-code-review/internal/config/rules"
	"github.com/KonghaYao/open-code-review/internal/reviewcore"
)

func TestPrepareFromSubdirectoryBindsTopLevel(t *testing.T) {
	tr := newTestRepo(t)
	tr.write("sub/a.txt", "a\n")
	tr.commit("base")
	tr.write("sub/a.txt", "b\n")

	repo, err := New(filepath.Join(tr.dir, "sub"), t.TempDir(), Options{})
	if err != nil {
		t.Fatalf("New(subdirectory): %v", err)
	}
	top, err := canonicalPath(tr.dir)
	if err != nil {
		t.Fatalf("canonicalize repo: %v", err)
	}
	if repo.root != top {
		t.Fatalf("repo root is %q, want the git top-level %q", repo.root, top)
	}
	snapshot := prepareInput(t, repo, reviewcore.InputSpec{Mode: reviewcore.ModeWorkspace})
	if snapshot.RepoRoot != top {
		t.Fatalf("snapshot root is %q, want %q", snapshot.RepoRoot, top)
	}
	change := findChange(t, snapshot, "sub/a.txt")
	if change.NewPath != "sub/a.txt" {
		t.Fatalf("paths must stay repository-relative: %+v", change)
	}
}

func TestPrepareCreatesNestedStateDirectory(t *testing.T) {
	tr := newTestRepo(t)
	tr.write("a.txt", "a\n")
	tr.commit("base")
	stateDir := filepath.Join(t.TempDir(), "nested", "state")

	repo, err := New(tr.dir, stateDir, Options{})
	if err != nil {
		t.Fatalf("New(nested state): %v", err)
	}
	if _, err := os.Stat(filepath.Join(stateDir, snapshotsDirName)); err != nil {
		t.Fatalf("snapshots directory was not created: %v", err)
	}
	prepareInput(t, repo, reviewcore.InputSpec{Mode: reviewcore.ModeWorkspace})
}

func TestPrepareRejectsUnknownRef(t *testing.T) {
	tr := newTestRepo(t)
	tr.write("a.txt", "a\n")
	head := tr.commit("base")
	repo := tr.newRepo(Options{})

	_, err := repo.Prepare(context.Background(), reviewcore.InputSpec{
		Mode: reviewcore.ModeRange, From: "does-not-exist", To: head,
	}, reviewcore.Scope{})
	requireCode(t, err, reviewcore.CodeGitFailure)

	_, err = repo.Prepare(context.Background(), reviewcore.InputSpec{
		Mode: reviewcore.ModeCommit, Commit: "does-not-exist",
	}, reviewcore.Scope{})
	requireCode(t, err, reviewcore.CodeGitFailure)
}

func TestPrepareRejectsUnrelatedHistories(t *testing.T) {
	tr := newTestRepo(t)
	tr.write("a.txt", "a\n")
	first := tr.commit("first")
	tr.git("checkout", "-q", "--orphan", "other")
	tr.git("rm", "-r", "-q", "--cached", ".")
	if err := os.Remove(filepath.Join(tr.dir, "a.txt")); err != nil {
		t.Fatalf("remove file: %v", err)
	}
	tr.write("b.txt", "b\n")
	second := tr.commit("second")

	repo := tr.newRepo(Options{})
	_, err := repo.Prepare(context.Background(), reviewcore.InputSpec{
		Mode: reviewcore.ModeRange, From: first, To: second,
	}, reviewcore.Scope{})
	requireCode(t, err, reviewcore.CodeGitFailure)
}

func TestPrepareRespectsCanceledContext(t *testing.T) {
	tr := newTestRepo(t)
	tr.write("a.txt", "a\n")
	tr.commit("base")
	repo := tr.newRepo(Options{})

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := repo.Prepare(ctx, reviewcore.InputSpec{Mode: reviewcore.ModeWorkspace}, reviewcore.Scope{})
	requireCode(t, err, reviewcore.CodeGitFailure)
}

func TestPrepareWorkspaceSymlink(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks need elevated privileges on Windows")
	}
	tr := newTestRepo(t)
	tr.write("target.txt", "target content\n")
	tr.commit("base")
	if err := os.Symlink("target.txt", filepath.Join(tr.dir, "link.txt")); err != nil {
		t.Fatalf("create symlink: %v", err)
	}

	repo := tr.newRepo(Options{})
	snapshot := prepareInput(t, repo, reviewcore.InputSpec{Mode: reviewcore.ModeWorkspace})
	change := findChange(t, snapshot, "link.txt")
	if change.Source != "untracked" || !strings.Contains(change.Diff, "+target.txt") {
		t.Fatalf("unexpected symlink change: %+v", change)
	}
	reader := mustOpen(t, repo, snapshot)
	if content := mustReadFile(t, reader, "link.txt", reviewcore.SideNew); content.Content != "target.txt" {
		t.Fatalf("symlink content should be its target: %q", content.Content)
	}
	tr.writeBytes("target.txt", []byte("target content\n"))
	if content := mustReadFile(t, reader, "link.txt", reviewcore.SideNew); content.Content != "target.txt" {
		t.Fatalf("frozen symlink changed: %q", content.Content)
	}

	tr.git("add", "-A")
	tr.commit("symlink")
	committed := prepareInput(t, repo, reviewcore.InputSpec{Mode: reviewcore.ModeCommit, Commit: tr.head()})
	committedReader := mustOpen(t, repo, committed)
	if content := mustReadFile(t, committedReader, "link.txt", reviewcore.SideNew); content.Content != "target.txt" {
		t.Fatalf("committed symlink content should be its target: %q", content.Content)
	}
}

func TestPrepareWorkspaceUntrackedBinary(t *testing.T) {
	tr := newTestRepo(t)
	tr.write("a.txt", "a\n")
	tr.commit("base")
	tr.writeBytes("new.bin", []byte("ab\x00cd\n"))

	repo := tr.newRepo(Options{})
	snapshot := prepareInput(t, repo, reviewcore.InputSpec{Mode: reviewcore.ModeWorkspace})
	change := findChange(t, snapshot, "new.bin")
	if !change.Binary || change.Source != "untracked" || !strings.Contains(change.Diff, "Binary files /dev/null") {
		t.Fatalf("unexpected binary change: %+v", change)
	}
	reader := mustOpen(t, repo, snapshot)
	if content := mustReadFile(t, reader, "new.bin", reviewcore.SideNew); !content.Binary {
		t.Fatalf("binary file was not flagged: %+v", content)
	}
}

func TestPrepareSameRepositoryTwice(t *testing.T) {
	tr := newTestRepo(t)
	tr.write("a.txt", "a\n")
	tr.commit("base")
	tr.write("a.txt", "b\n")

	repo := tr.newRepo(Options{})
	first := prepareInput(t, repo, reviewcore.InputSpec{Mode: reviewcore.ModeWorkspace})
	second := prepareInput(t, repo, reviewcore.InputSpec{Mode: reviewcore.ModeWorkspace})
	if first.ID != second.ID {
		t.Fatalf("re-preparing an unchanged worktree changed the id: %s != %s", first.ID, second.ID)
	}
	if content := mustReadFile(t, mustOpen(t, repo, second), "a.txt", reviewcore.SideNew); content.Content != "b\n" {
		t.Fatalf("unexpected content after reuse: %q", content.Content)
	}
}

func TestRulesProjectFileBinary(t *testing.T) {
	tr := newTestRepo(t)
	tr.write("main.go", "package main\n")
	tr.writeBytes(projectRulePath, []byte("{\x00}"))
	tr.commit("base")

	repo := tr.newRepo(Options{})
	snapshot := prepareInput(t, repo, reviewcore.InputSpec{Mode: reviewcore.ModeCommit, Commit: tr.head()})
	reader := mustOpen(t, repo, snapshot)
	_, err := repo.Rules(context.Background(), reader, []string{"main.go"})
	requireCode(t, err, reviewcore.CodePreparationFailed)
}

func TestRulesProjectFileTooLarge(t *testing.T) {
	tr := newTestRepo(t)
	tr.write("main.go", "package main\n")
	tr.write(projectRulePath, `{"rules":[{"path":"**/*.go","rule":"`+strings.Repeat("x", 100)+`"}]}`)
	tr.commit("base")

	repo := tr.newRepo(Options{MaxFileBytes: 32})
	snapshot := prepareInput(t, repo, reviewcore.InputSpec{Mode: reviewcore.ModeCommit, Commit: tr.head()})
	reader := mustOpen(t, repo, snapshot)
	_, err := repo.Rules(context.Background(), reader, []string{"main.go"})
	requireCode(t, err, reviewcore.CodePreparationFailed)
}

func TestRulesEmptyProjectFile(t *testing.T) {
	tr := newTestRepo(t)
	tr.write("main.go", "package main\n")
	tr.write(projectRulePath, "")
	tr.commit("base")

	repo := tr.newRepo(Options{})
	snapshot := prepareInput(t, repo, reviewcore.InputSpec{Mode: reviewcore.ModeCommit, Commit: tr.head()})
	reader := mustOpen(t, repo, snapshot)
	pack, err := repo.Rules(context.Background(), reader, []string{"main.go"})
	if err != nil {
		t.Fatalf("Rules: %v", err)
	}
	if len(pack.Include) != 0 || len(pack.Exclude) != 0 {
		t.Fatalf("empty project file must not add filters: %+v", pack)
	}
	if len(pack.Groups) != 1 || pack.Groups[0].Source != systemSource {
		t.Fatalf("unexpected groups: %+v", pack.Groups)
	}
}

func TestRulesEmptyMergedRule(t *testing.T) {
	tr := newTestRepo(t)
	tr.write("main.go", "package main\n")
	tr.write(projectRulePath, `{"rules":[{"path":"**/*.go","rule":"","merge_system_rule":true}]}`)
	tr.commit("base")

	repo := tr.newRepo(Options{})
	snapshot := prepareInput(t, repo, reviewcore.InputSpec{Mode: reviewcore.ModeCommit, Commit: tr.head()})
	reader := mustOpen(t, repo, snapshot)
	pack, err := repo.Rules(context.Background(), reader, []string{"main.go"})
	if err != nil {
		t.Fatalf("Rules: %v", err)
	}
	group := ruleGroup(pack, projectSource, "**/*.go")
	if group == nil {
		t.Fatalf("missing merged group: %+v", pack.Groups)
	}
	system, err := rules.LoadDefault()
	if err != nil {
		t.Fatalf("LoadDefault: %v", err)
	}
	_, want := matchSystemRule(system, "main.go")
	if group.Text != want {
		t.Fatalf("an empty project rule should keep the system text: got %q want %q", group.Text, want)
	}
}
