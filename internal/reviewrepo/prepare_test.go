// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package reviewrepo

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/KonghaYao/open-code-review/internal/reviewcore"
)

func TestNewRejectsStateDirInsideRepository(t *testing.T) {
	tr := newTestRepo(t)
	tr.write("a.txt", "a\n")
	tr.commit("init")

	_, err := New(tr.dir, filepath.Join(tr.dir, ".review-state"), Options{})
	requireCode(t, err, reviewcore.CodeInvalidInput)
}

func TestNewRejectsNonRepository(t *testing.T) {
	dir := t.TempDir()
	_, err := New(dir, t.TempDir(), Options{})
	requireCode(t, err, reviewcore.CodeGitFailure)
}

func TestPrepareRange(t *testing.T) {
	tr := newTestRepo(t)
	tr.write("keep.txt", "keep\n")
	tr.write("gone.txt", "gone\n")
	tr.write("a.txt", "one\ntwo\n")
	base := tr.commit("base")

	tr.write("a.txt", "one\nTWO\nthree\n")
	tr.remove("gone.txt")
	tr.write("added.txt", "new file\n")
	head := tr.commit("second")

	repo := tr.newRepo(Options{})
	snapshot := prepareInput(t, repo, reviewcore.InputSpec{Mode: reviewcore.ModeRange, From: base, To: head})

	if snapshot.Mode != reviewcore.ModeRange || snapshot.BaseSHA != base || snapshot.HeadSHA != head || snapshot.MergeBaseSHA != base {
		t.Fatalf("unexpected snapshot identity: %+v", snapshot.Summarize())
	}
	if snapshot.ID == "" || !strings.HasPrefix(snapshot.ID, "snap_") {
		t.Fatalf("unexpected snapshot id %q", snapshot.ID)
	}
	if snapshot.InputDigest == "" || snapshot.CreatedAt.IsZero() {
		t.Fatalf("snapshot metadata is incomplete: %+v", snapshot.Summarize())
	}

	modified := findChange(t, snapshot, "a.txt")
	if modified.Status != statusModified || modified.OldPath != "a.txt" || modified.NewPath != "a.txt" {
		t.Fatalf("unexpected modification: %+v", modified)
	}
	if modified.Insertions != 2 || modified.Deletions != 1 || len(modified.Hunks) != 1 {
		t.Fatalf("unexpected hunk accounting: %+v", modified)
	}
	if !strings.Contains(modified.Diff, "diff --git a/a.txt b/a.txt") {
		t.Fatalf("diff text is missing the header: %q", modified.Diff)
	}
	if modified.IsTest {
		t.Fatal("a.txt must not be classified as a test")
	}

	added := findChange(t, snapshot, "added.txt")
	if added.Status != statusAdded || added.OldPath != "" || added.NewPath != "added.txt" {
		t.Fatalf("unexpected addition: %+v", added)
	}
	deleted := findChange(t, snapshot, "gone.txt")
	if deleted.Status != statusDeleted || deleted.NewPath != "" || deleted.OldPath != "gone.txt" {
		t.Fatalf("unexpected deletion: %+v", deleted)
	}

	if !hasFile(snapshot, reviewcore.SideOld, "a.txt") || !hasFile(snapshot, reviewcore.SideNew, "a.txt") {
		t.Fatal("both sides of a.txt must be part of the manifest")
	}
	if hasFile(snapshot, reviewcore.SideNew, "gone.txt") || !hasFile(snapshot, reviewcore.SideOld, "gone.txt") {
		t.Fatal("a deleted file must only exist on the old side")
	}
	if hasFile(snapshot, reviewcore.SideOld, "added.txt") || !hasFile(snapshot, reviewcore.SideNew, "added.txt") {
		t.Fatal("an added file must only exist on the new side")
	}

	reader := mustOpen(t, repo, snapshot)
	newSide := mustReadFile(t, reader, "a.txt", reviewcore.SideNew)
	if newSide.Content != "one\nTWO\nthree\n" || newSide.TotalLines != 3 || newSide.Digest == "" {
		t.Fatalf("unexpected new content: %+v", newSide)
	}
	oldSide := mustReadFile(t, reader, "a.txt", reviewcore.SideOld)
	if oldSide.Content != "one\ntwo\n" || oldSide.TotalLines != 2 {
		t.Fatalf("unexpected old content: %+v", oldSide)
	}
}

func TestPrepareCommitRootCommit(t *testing.T) {
	tr := newTestRepo(t)
	tr.write("a.txt", "hello\n")
	root := tr.commit("root")

	repo := tr.newRepo(Options{})
	snapshot := prepareInput(t, repo, reviewcore.InputSpec{Mode: reviewcore.ModeCommit, Commit: root})

	if snapshot.BaseSHA != emptyTreeSHA || snapshot.HeadSHA != root || snapshot.MergeBaseSHA != "" {
		t.Fatalf("unexpected root snapshot identity: %+v", snapshot.Summarize())
	}
	change := findChange(t, snapshot, "a.txt")
	if change.Status != statusAdded || change.Insertions != 1 {
		t.Fatalf("unexpected root change: %+v", change)
	}
	if hasFile(snapshot, reviewcore.SideOld, "a.txt") {
		t.Fatal("a root commit has no old tree")
	}

	reader := mustOpen(t, repo, snapshot)
	if content := mustReadFile(t, reader, "a.txt", reviewcore.SideNew); content.Content != "hello\n" {
		t.Fatalf("unexpected content %q", content.Content)
	}
	_, err := reader.ReadFile(context.Background(), "a.txt", reviewcore.SideOld)
	requireCode(t, err, reviewcore.CodePathOutOfScope)
}

func TestPrepareCommitMergeUsesFirstParent(t *testing.T) {
	tr := newTestRepo(t)
	tr.write("base.txt", "base\n")
	first := tr.commit("base")
	tr.write("main.txt", "main\n")
	second := tr.commit("main")

	tr.git("checkout", "-q", "-b", "feature", first)
	tr.write("feature.txt", "feature\n")
	tr.commit("feature")
	tr.git("checkout", "-q", "main")
	tr.git("merge", "-q", "--no-ff", "-m", "merge feature", "feature")
	merge := tr.head()

	repo := tr.newRepo(Options{})
	snapshot := prepareInput(t, repo, reviewcore.InputSpec{Mode: reviewcore.ModeCommit, Commit: merge})
	if snapshot.BaseSHA != second {
		t.Fatalf("merge base should be the first parent %s, got %s", second, snapshot.BaseSHA)
	}
	if len(snapshot.Changes) != 1 {
		t.Fatalf("merge diff should only contain the feature change, got %v", changePaths(snapshot))
	}
	if change := findChange(t, snapshot, "feature.txt"); change.Status != statusAdded {
		t.Fatalf("unexpected change: %+v", change)
	}
}

func TestPrepareWorkspace(t *testing.T) {
	tr := newTestRepo(t)
	tr.write("staged.txt", "s1\n")
	tr.write("tracked.txt", "t1\n")
	tr.write("gone.txt", "bye\n")
	var renameBody strings.Builder
	for i := 0; i < 20; i++ {
		renameBody.WriteString("line ")
		renameBody.WriteString(strings.Repeat("x", i%5+1))
		renameBody.WriteString("\n")
	}
	tr.write("old-name.txt", renameBody.String())
	tr.write("bin.dat", "plain\n")
	tr.write(".env", "TRACKED_SECRET=original\n")
	tr.commit("base")

	tr.write("staged.txt", "s2\n")
	tr.git("add", "staged.txt")
	tr.write("staged-new.txt", "sn\n")
	tr.git("add", "staged-new.txt")

	tr.write("tracked.txt", "t2\n")
	tr.remove("gone.txt")
	tr.git("mv", "old-name.txt", "new-name.txt")
	tr.write("new-name.txt", renameBody.String()+"extra\n")
	tr.writeBytes("bin.dat", []byte("binary\x00payload\n"))
	tr.write(".env", "TRACKED_SECRET=changed\n")
	tr.write("untracked.txt", "u1\nu2\n")
	tr.write(".env.local", "UNTRACKED_SECRET=leak\n")

	repo := tr.newRepo(Options{})
	snapshot := prepareInput(t, repo, reviewcore.InputSpec{Mode: reviewcore.ModeWorkspace})
	if snapshot.Mode != reviewcore.ModeWorkspace || snapshot.HeadSHA == "" || snapshot.BaseSHA != snapshot.HeadSHA {
		t.Fatalf("unexpected workspace identity: %+v", snapshot.Summarize())
	}

	staged := findChange(t, snapshot, "staged.txt")
	if staged.Source != "workspace" || staged.Status != statusModified {
		t.Fatalf("unexpected staged change: %+v", staged)
	}
	stagedNew := findChange(t, snapshot, "staged-new.txt")
	if stagedNew.Source != "workspace" || stagedNew.Status != statusAdded {
		t.Fatalf("unexpected staged addition: %+v", stagedNew)
	}
	tracked := findChange(t, snapshot, "tracked.txt")
	if tracked.OldDigest == "" || tracked.NewDigest == "" || tracked.OldDigest == tracked.NewDigest {
		t.Fatalf("tracked digests must differ: %+v", tracked)
	}
	gone := findChange(t, snapshot, "gone.txt")
	if gone.Status != statusDeleted || gone.NewPath != "" {
		t.Fatalf("unexpected deletion: %+v", gone)
	}
	renamed := findChange(t, snapshot, "new-name.txt")
	if renamed.Status != statusRenamed || renamed.OldPath != "old-name.txt" || renamed.NewPath != "new-name.txt" {
		t.Fatalf("unexpected rename: %+v", renamed)
	}
	binary := findChange(t, snapshot, "bin.dat")
	if !binary.Binary || len(binary.Hunks) != 0 {
		t.Fatalf("unexpected binary change: %+v", binary)
	}
	untracked := findChange(t, snapshot, "untracked.txt")
	if untracked.Source != "untracked" || untracked.Status != statusAdded || untracked.Insertions != 2 {
		t.Fatalf("unexpected untracked change: %+v", untracked)
	}
	if !strings.Contains(untracked.Diff, "+u1") || len(untracked.Hunks) != 1 {
		t.Fatalf("untracked diff was not synthesized: %+v", untracked)
	}
	for _, secret := range []string{".env", ".env.local"} {
		change := findChange(t, snapshot, secret)
		if change.Diff != "" || len(change.Hunks) != 0 {
			t.Fatalf("secret change %s must not carry content: %+v", secret, change)
		}
		if excludedEntry(snapshot, secret, reviewcore.ExcludeSecret) == nil {
			t.Fatalf("secret path %s must be recorded as excluded", secret)
		}
		if hasFile(snapshot, reviewcore.SideNew, secret) || hasFile(snapshot, reviewcore.SideOld, secret) {
			t.Fatalf("secret path %s must never be listed", secret)
		}
	}

	meta, err := os.ReadFile(filepath.Join(repo.snapshotDir(snapshot.ID), snapshotFileName))
	if err != nil {
		t.Fatalf("read snapshot metadata: %v", err)
	}
	for _, leaked := range []string{"TRACKED_SECRET=changed", "UNTRACKED_SECRET=leak"} {
		if strings.Contains(string(meta), leaked) {
			t.Fatalf("snapshot metadata leaked secret content %q", leaked)
		}
	}

	reader := mustOpen(t, repo, snapshot)
	for path, want := range map[string]string{
		"tracked.txt":    "t2\n",
		"staged.txt":     "s2\n",
		"staged-new.txt": "sn\n",
		"untracked.txt":  "u1\nu2\n",
		"new-name.txt":   renameBody.String() + "extra\n",
	} {
		if content := mustReadFile(t, reader, path, reviewcore.SideNew); content.Content != want {
			t.Fatalf("%s: want %q, got %q", path, want, content.Content)
		}
	}
	if content := mustReadFile(t, reader, "tracked.txt", reviewcore.SideOld); content.Content != "t1\n" {
		t.Fatalf("unexpected old tracked content %q", content.Content)
	}
	if content := mustReadFile(t, reader, "old-name.txt", reviewcore.SideOld); content.Content != renameBody.String() {
		t.Fatalf("unexpected old renamed content %q", content.Content)
	}
	if content := mustReadFile(t, reader, "bin.dat", reviewcore.SideNew); !content.Binary || content.Content != "" {
		t.Fatalf("binary file must be flagged without content: %+v", content)
	}
	if _, err := reader.ReadFile(context.Background(), "gone.txt", reviewcore.SideNew); !reviewcore.IsCode(err, reviewcore.CodePathOutOfScope) {
		t.Fatalf("deleted path must be absent from the new side: %v", err)
	}
	if _, err := reader.ReadFile(context.Background(), "old-name.txt", reviewcore.SideNew); !reviewcore.IsCode(err, reviewcore.CodePathOutOfScope) {
		t.Fatalf("renamed path must be absent from the new side: %v", err)
	}
	if _, err := reader.ReadFile(context.Background(), ".env", reviewcore.SideNew); !reviewcore.IsCode(err, reviewcore.CodeSecretPath) {
		t.Fatalf("secret path must be readable as a secret error: %v", err)
	}
	if _, err := reader.ReadFile(context.Background(), "gone.txt", reviewcore.SideOld); err != nil {
		t.Fatalf("deleted file must remain readable on the old side: %v", err)
	}

	// The snapshot is frozen: later worktree edits must not change reads.
	tr.write("tracked.txt", "t3\n")
	tr.write("untracked.txt", "u3\n")
	if content := mustReadFile(t, reader, "tracked.txt", reviewcore.SideNew); content.Content != "t2\n" {
		t.Fatalf("snapshot read changed after the worktree moved: %q", content.Content)
	}
	if content := mustReadFile(t, reader, "untracked.txt", reviewcore.SideNew); content.Content != "u1\nu2\n" {
		t.Fatalf("untracked snapshot read changed after the worktree moved: %q", content.Content)
	}
}

func TestPrepareWorkspaceDeleteAndRecreate(t *testing.T) {
	tr := newTestRepo(t)
	tr.write("file.txt", "v1\n")
	tr.commit("base")
	tr.remove("file.txt")
	tr.write("file.txt", "v2\n")

	repo := tr.newRepo(Options{})
	snapshot := prepareInput(t, repo, reviewcore.InputSpec{Mode: reviewcore.ModeWorkspace})
	change := findChange(t, snapshot, "file.txt")
	if change.Status != statusModified || change.NewPath != "file.txt" {
		t.Fatalf("delete and recreate must stay a modification: %+v", change)
	}
	if change.OldDigest == "" || change.NewDigest == "" || change.OldDigest == change.NewDigest {
		t.Fatalf("recreated content must produce a new digest: %+v", change)
	}
	reader := mustOpen(t, repo, snapshot)
	if content := mustReadFile(t, reader, "file.txt", reviewcore.SideNew); content.Content != "v2\n" {
		t.Fatalf("unexpected recreated content %q", content.Content)
	}
	if content := mustReadFile(t, reader, "file.txt", reviewcore.SideOld); content.Content != "v1\n" {
		t.Fatalf("unexpected old content %q", content.Content)
	}
}

func TestPrepareWorkspaceUnbornHead(t *testing.T) {
	tr := newTestRepo(t)
	tr.write("staged.txt", "s\n")
	tr.git("add", "staged.txt")
	tr.write("untracked.txt", "u\n")

	repo := tr.newRepo(Options{})
	snapshot := prepareInput(t, repo, reviewcore.InputSpec{Mode: reviewcore.ModeWorkspace})
	if snapshot.HeadSHA != "" || snapshot.BaseSHA != "" {
		t.Fatalf("an unborn HEAD must not resolve to a commit: %+v", snapshot.Summarize())
	}
	if len(snapshot.Changes) != 2 {
		t.Fatalf("expected staged and untracked changes, got %v", changePaths(snapshot))
	}
	if change := findChange(t, snapshot, "staged.txt"); change.Source != "workspace" || change.Status != statusAdded {
		t.Fatalf("unexpected staged change: %+v", change)
	}
	if change := findChange(t, snapshot, "untracked.txt"); change.Source != "untracked" {
		t.Fatalf("unexpected untracked change: %+v", change)
	}
	reader := mustOpen(t, repo, snapshot)
	for path, want := range map[string]string{"staged.txt": "s\n", "untracked.txt": "u\n"} {
		if content := mustReadFile(t, reader, path, reviewcore.SideNew); content.Content != want {
			t.Fatalf("%s: want %q, got %q", path, want, content.Content)
		}
	}
	if _, err := reader.ReadFile(context.Background(), "staged.txt", reviewcore.SideOld); !reviewcore.IsCode(err, reviewcore.CodePathOutOfScope) {
		t.Fatalf("unborn HEAD has no old side: %v", err)
	}
}

func TestPrepareWorkspaceDetectsInputChanged(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the PATH shim is a POSIX shell script")
	}
	tr := newTestRepo(t)
	tr.write("tracked.txt", "t1\n")
	tr.commit("base")
	tr.write("tracked.txt", "t2\n")

	realGit, err := exec.LookPath("git")
	if err != nil {
		t.Fatalf("locate git: %v", err)
	}
	binDir := t.TempDir()
	marker := filepath.Join(t.TempDir(), "mutated")
	script := "#!/bin/sh\n\"$OCR_REAL_GIT\" \"$@\"\nstatus=$?\n" +
		"if [ \"$4\" = \"diff\" ] && [ ! -e \"$OCR_MARKER\" ]; then\n" +
		"  : > \"$OCR_MARKER\"\n  echo changed >> \"$OCR_TARGET\"\nfi\nexit $status\n"
	if err := os.WriteFile(filepath.Join(binDir, "git"), []byte(script), 0o755); err != nil {
		t.Fatalf("write git shim: %v", err)
	}
	t.Setenv("OCR_REAL_GIT", realGit)
	t.Setenv("OCR_MARKER", marker)
	t.Setenv("OCR_TARGET", filepath.Join(tr.dir, "tracked.txt"))
	t.Setenv("PATH", binDir+string(os.PathListSeparator)+os.Getenv("PATH"))

	repo := tr.newRepo(Options{})
	_, err = repo.Prepare(context.Background(), reviewcore.InputSpec{Mode: reviewcore.ModeWorkspace}, reviewcore.Scope{})
	requireCode(t, err, reviewcore.CodeInputChanged)
}

func TestPrepareTruncatesLargeDiff(t *testing.T) {
	tr := newTestRepo(t)
	var body strings.Builder
	for i := 0; i < 40; i++ {
		body.WriteString("original line\n")
	}
	tr.write("a.txt", body.String())
	base := tr.commit("base")
	var changed strings.Builder
	for i := 0; i < 40; i++ {
		changed.WriteString("changed line with more bytes\n")
	}
	tr.write("a.txt", changed.String())
	head := tr.commit("change")

	repo := tr.newRepo(Options{MaxDiffBytes: 200})
	snapshot := prepareInput(t, repo, reviewcore.InputSpec{Mode: reviewcore.ModeRange, From: base, To: head})
	change := findChange(t, snapshot, "a.txt")
	if !change.DiffTruncated {
		t.Fatal("diff should be marked truncated")
	}
	if len(change.Diff) > 200 {
		t.Fatalf("diff is %d bytes, expected at most 200", len(change.Diff))
	}
	if !strings.Contains(change.Diff, "diff --git") {
		t.Fatalf("truncated diff lost its header: %q", change.Diff)
	}
}

func TestPrepareMarksTooLargeFile(t *testing.T) {
	tr := newTestRepo(t)
	tr.write("big.txt", strings.Repeat("a", 10)+"\n")
	base := tr.commit("base")
	tr.write("big.txt", strings.Repeat("b", 100)+"\n")
	head := tr.commit("grow")

	repo := tr.newRepo(Options{MaxFileBytes: 32})
	snapshot := prepareInput(t, repo, reviewcore.InputSpec{Mode: reviewcore.ModeRange, From: base, To: head})
	if excludedEntry(snapshot, "big.txt", reviewcore.ExcludeTooLarge) == nil {
		t.Fatalf("too large file must be excluded: %+v", snapshot.Excluded)
	}
	reader := mustOpen(t, repo, snapshot)
	content := mustReadFile(t, reader, "big.txt", reviewcore.SideNew)
	if !content.TooLarge || content.Content != "" {
		t.Fatalf("unexpected too large content: %+v", content)
	}
	_, err := reader.ReadFileLines(context.Background(), "big.txt", reviewcore.SideNew, 1, 10)
	requireCode(t, err, reviewcore.CodePayloadTooLarge)
}

func TestPrepareSnapshotIDIsDeterministic(t *testing.T) {
	tr := newTestRepo(t)
	tr.write("a.txt", "one\n")
	base := tr.commit("base")
	tr.write("a.txt", "two\n")
	head := tr.commit("change")
	tr.write("a.txt", "three\n")

	input := reviewcore.InputSpec{Mode: reviewcore.ModeRange, From: base, To: head}
	first := prepareInput(t, tr.newRepo(Options{}), input)
	second := prepareInput(t, tr.newRepo(Options{}), input)
	if first.ID != second.ID {
		t.Fatalf("identical inputs produced %s and %s", first.ID, second.ID)
	}

	workspaceInput := reviewcore.InputSpec{Mode: reviewcore.ModeWorkspace}
	firstWorkspace := prepareInput(t, tr.newRepo(Options{}), workspaceInput)
	secondWorkspace := prepareInput(t, tr.newRepo(Options{}), workspaceInput)
	if firstWorkspace.ID != secondWorkspace.ID {
		t.Fatalf("identical worktrees produced %s and %s", firstWorkspace.ID, secondWorkspace.ID)
	}
	if firstWorkspace.ID == first.ID {
		t.Fatal("a different mode must not reuse a snapshot id")
	}

	repo := tr.newRepo(Options{})
	snapshot := prepareInput(t, repo, input)
	meta, err := os.ReadFile(filepath.Join(repo.snapshotDir(snapshot.ID), snapshotFileName))
	if err != nil {
		t.Fatalf("snapshot metadata missing: %v", err)
	}
	var stored reviewcore.Snapshot
	if err := json.Unmarshal(meta, &stored); err != nil {
		t.Fatalf("decode snapshot metadata: %v", err)
	}
	if stored.ID != snapshot.ID || stored.HeadSHA != head {
		t.Fatalf("stored metadata does not match: %+v", stored.Summarize())
	}
}

func TestOpenReportsMissingSnapshot(t *testing.T) {
	tr := newTestRepo(t)
	tr.write("a.txt", "one\n")
	tr.commit("base")
	tr.write("a.txt", "two\n")

	repo := tr.newRepo(Options{})
	snapshot := prepareInput(t, repo, reviewcore.InputSpec{Mode: reviewcore.ModeWorkspace})
	if err := os.RemoveAll(repo.snapshotDir(snapshot.ID)); err != nil {
		t.Fatalf("remove snapshot: %v", err)
	}
	_, err := repo.Open(snapshot)
	requireCode(t, err, reviewcore.CodeSnapshotMissing)

	second := prepareInput(t, repo, reviewcore.InputSpec{Mode: reviewcore.ModeWorkspace})
	reader := mustOpen(t, repo, second)
	copyPath := filepath.Join(repo.snapshotDir(second.ID), newSideDirName, copyName("a.txt"))
	if err := os.Remove(copyPath); err != nil {
		t.Fatalf("remove snapshot copy: %v", err)
	}
	_, err = reader.ReadFile(context.Background(), "a.txt", reviewcore.SideNew)
	requireCode(t, err, reviewcore.CodeSnapshotMissing)
}

func TestOpenRejectsForeignSnapshot(t *testing.T) {
	tr := newTestRepo(t)
	tr.write("a.txt", "one\n")
	tr.commit("base")
	repo := tr.newRepo(Options{})
	snapshot := prepareInput(t, repo, reviewcore.InputSpec{Mode: reviewcore.ModeCommit, Commit: tr.head()})

	if _, err := repo.Open(nil); !reviewcore.IsCode(err, reviewcore.CodeInvalidInput) {
		t.Fatalf("nil snapshot must be rejected: %v", err)
	}
	foreign := *snapshot
	foreign.RepoRoot = filepath.Dir(tr.dir)
	if _, err := repo.Open(&foreign); !reviewcore.IsCode(err, reviewcore.CodeInvalidInput) {
		t.Fatalf("foreign snapshot must be rejected: %v", err)
	}
	broken := *snapshot
	broken.ID = "snap_unknown"
	if _, err := repo.Open(&broken); !reviewcore.IsCode(err, reviewcore.CodeSnapshotMissing) {
		t.Fatalf("unknown snapshot must be reported missing: %v", err)
	}
}
