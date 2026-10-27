// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package reviewrepo

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"

	"github.com/KonghaYao/open-code-review/internal/reviewcore"
)

func TestUnquoteGitPathEscapes(t *testing.T) {
	cases := []struct {
		input string
		want  string
		tail  string
		ok    bool
	}{
		{`"a\a\b\f\n\r\t\v\"\\z"`, "a\a\b\f\n\r\t\v\"\\z", "", true},
		{`"\101"`, "A", "", true},
		{`"\400"`, "", `"\400"`, false},
		{`"\77"`, "", `"\77"`, false},
		{`"\z"`, "", `"\z"`, false},
		{`"unterminated`, "", `"unterminated`, false},
		{`"ok"tail`, "ok", "tail", true},
		{`plain`, "", "plain", false},
	}
	for _, testCase := range cases {
		decoded, tail, ok := unquoteGitPath(testCase.input)
		if decoded != testCase.want || tail != testCase.tail || ok != testCase.ok {
			t.Fatalf("unquoteGitPath(%q) = (%q, %q, %v), want (%q, %q, %v)",
				testCase.input, decoded, tail, ok, testCase.want, testCase.tail, testCase.ok)
		}
	}
}

func TestParseGitPath(t *testing.T) {
	cases := map[string]string{
		"":                    "",
		"plain.txt":           "plain.txt",
		"a/x.txt\t2026-01-01": "a/x.txt",
		`"tab\tname.txt"`:     "tab\tname.txt",
		`"bad`:                `"bad`,
	}
	for input, want := range cases {
		if got := parseGitPath(input); got != want {
			t.Fatalf("parseGitPath(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestAtomicWriteFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "nested", "file.txt")
	if err := atomicWriteFile(path, []byte("first")); err != nil {
		t.Fatalf("atomicWriteFile: %v", err)
	}
	if err := atomicWriteFile(path, []byte("second")); err != nil {
		t.Fatalf("atomicWriteFile(replace): %v", err)
	}
	data, err := os.ReadFile(path)
	if err != nil || string(data) != "second" {
		t.Fatalf("unexpected content %q, %v", data, err)
	}

	blocker := filepath.Join(dir, "blocker")
	if err := os.WriteFile(blocker, []byte("x"), 0o644); err != nil {
		t.Fatalf("write blocker: %v", err)
	}
	if err := atomicWriteFile(filepath.Join(blocker, "file.txt"), []byte("x")); err == nil {
		t.Fatal("writing under a regular file must fail")
	}
}

func TestReadBlobRejectsBadObjectID(t *testing.T) {
	tr := newTestRepo(t)
	tr.write("a.txt", "a\n")
	tr.commit("base")
	repo := tr.newRepo(Options{})

	_, err := repo.readBlob(context.Background(), "not-an-object")
	requireCode(t, err, reviewcore.CodeInternal)

	_, err = repo.readBlob(context.Background(), strings.Repeat("0", 40))
	requireCode(t, err, reviewcore.CodeGitFailure)
}

func TestNewValidatesArguments(t *testing.T) {
	tr := newTestRepo(t)
	tr.write("a.txt", "a\n")
	tr.commit("base")

	if _, err := New("", t.TempDir(), Options{}); !reviewcore.IsCode(err, reviewcore.CodeInvalidInput) {
		t.Fatalf("empty root must be rejected: %v", err)
	}
	if _, err := New(tr.dir, "", Options{}); !reviewcore.IsCode(err, reviewcore.CodeInvalidInput) {
		t.Fatalf("empty state directory must be rejected: %v", err)
	}
	file := filepath.Join(t.TempDir(), "file.txt")
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatalf("write file: %v", err)
	}
	if _, err := New(file, t.TempDir(), Options{}); !reviewcore.IsCode(err, reviewcore.CodeInvalidInput) {
		t.Fatalf("a file root must be rejected: %v", err)
	}
}

func TestReaderReadLinesTooLarge(t *testing.T) {
	tr := newTestRepo(t)
	tr.write("big.txt", strings.Repeat("a", 100)+"\n")
	tr.commit("base")
	repo := tr.newRepo(Options{MaxFileBytes: 16})
	snapshot := prepareInput(t, repo, reviewcore.InputSpec{Mode: reviewcore.ModeCommit, Commit: tr.head()})
	reader := mustOpen(t, repo, snapshot)

	_, err := reader.ReadLines(context.Background(), "big.txt", reviewcore.SideNew)
	requireCode(t, err, reviewcore.CodePayloadTooLarge)
}

func TestReaderRenderSlicesBounds(t *testing.T) {
	tr := newTestRepo(t)
	tr.write("a.txt", "one\n")
	base := tr.commit("base")
	tr.write("a.txt", "one\ntwo\n")
	head := tr.commit("change")
	repo := tr.newRepo(Options{})
	snapshot := prepareInput(t, repo, reviewcore.InputSpec{Mode: reviewcore.ModeRange, From: base, To: head})
	reader := mustOpen(t, repo, snapshot)
	change := findChange(t, snapshot, "a.txt")

	out, err := reader.UnitDiff(context.Background(), reviewcore.Unit{
		Kind:      reviewcore.UnitFile,
		ChangeIDs: []string{change.ID},
		Slices: []reviewcore.HunkSlice{
			{HunkIndex: 99},
			{HunkIndex: 0, Start: 50, End: 60},
		},
	})
	if err != nil {
		t.Fatalf("UnitDiff: %v", err)
	}
	if !strings.Contains(out, "diff --git a/a.txt b/a.txt") {
		t.Fatalf("header was not rendered: %q", out)
	}
	if strings.Contains(out, change.Hunks[0].Header) {
		t.Fatalf("no slice was in range, so no hunk should be rendered: %q", out)
	}

	clamped, err := reader.UnitDiff(context.Background(), reviewcore.Unit{
		Kind:      reviewcore.UnitFile,
		ChangeIDs: []string{change.ID},
		Slices:    []reviewcore.HunkSlice{{HunkIndex: 0, Start: -1, End: 1}},
	})
	if err != nil {
		t.Fatalf("UnitDiff(clamped): %v", err)
	}
	if !strings.Contains(clamped, change.Hunks[0].Header) || !strings.Contains(clamped, change.Hunks[0].Lines[0]) {
		t.Fatalf("a negative start must clamp to the first line: %q", clamped)
	}
}

func TestPrepareWorkspaceProviderPath(t *testing.T) {
	tr := newTestRepo(t)
	tr.write("a.txt", "a\n")
	tr.commit("base")
	tr.write("vendor/lib.go", "package lib\n")

	repo := tr.newRepo(Options{})
	snapshot := prepareInput(t, repo, reviewcore.InputSpec{Mode: reviewcore.ModeWorkspace})
	change := findChange(t, snapshot, "vendor/lib.go")
	if change.Source != "untracked" {
		t.Fatalf("unexpected change: %+v", change)
	}
	if excludedEntry(snapshot, "vendor/lib.go", reviewcore.ExcludeProvider) == nil {
		t.Fatalf("provider path must be recorded: %+v", snapshot.Excluded)
	}
	if hasFile(snapshot, reviewcore.SideNew, "vendor/lib.go") {
		t.Fatal("provider path must stay out of the manifest")
	}
	reader := mustOpen(t, repo, snapshot)
	if _, err := reader.ReadFile(context.Background(), "vendor/lib.go", reviewcore.SideNew); !reviewcore.IsCode(err, reviewcore.CodePathOutOfScope) {
		t.Fatalf("provider path must be unreadable: %v", err)
	}
}

func TestPrepareWorkspaceUntrackedTooLarge(t *testing.T) {
	tr := newTestRepo(t)
	tr.write("a.txt", "a\n")
	tr.commit("base")
	tr.write("big.txt", strings.Repeat("x", 100))

	repo := tr.newRepo(Options{MaxFileBytes: 32})
	snapshot := prepareInput(t, repo, reviewcore.InputSpec{Mode: reviewcore.ModeWorkspace})
	if excludedEntry(snapshot, "big.txt", reviewcore.ExcludeTooLarge) == nil {
		t.Fatalf("too large untracked file must be recorded: %+v", snapshot.Excluded)
	}
	reader := mustOpen(t, repo, snapshot)
	content := mustReadFile(t, reader, "big.txt", reviewcore.SideNew)
	if !content.TooLarge || content.Content != "" {
		t.Fatalf("unexpected too large content: %+v", content)
	}
	_, err := reader.ReadFileLines(context.Background(), "big.txt", reviewcore.SideNew, 1, 5)
	requireCode(t, err, reviewcore.CodePayloadTooLarge)
}

func TestPrepareWorkspaceNonRegularFile(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("FIFOs are POSIX only")
	}
	tr := newTestRepo(t)
	tr.write("a.txt", "a\n")
	tr.commit("base")
	if err := syscall.Mkfifo(filepath.Join(tr.dir, "pipe"), 0o600); err != nil {
		t.Fatalf("mkfifo: %v", err)
	}

	repo := tr.newRepo(Options{})
	snapshot := prepareInput(t, repo, reviewcore.InputSpec{Mode: reviewcore.ModeWorkspace})
	reader := mustOpen(t, repo, snapshot)
	if _, err := reader.ReadFile(context.Background(), "pipe", reviewcore.SideNew); !reviewcore.IsCode(err, reviewcore.CodePathOutOfScope) {
		t.Fatalf("a FIFO must not enter the snapshot: %v", err)
	}
}

func TestPrepareSkipsSubmoduleEntries(t *testing.T) {
	tr := newTestRepo(t)
	tr.write("a.txt", "a\n")
	base := tr.commit("base")
	tr.git("update-index", "--add", "--cacheinfo", "160000,"+base+",sub")
	tr.git("commit", "-q", "-m", "submodule")
	head := tr.head()

	repo := tr.newRepo(Options{})
	snapshot := prepareInput(t, repo, reviewcore.InputSpec{Mode: reviewcore.ModeRange, From: base, To: head})
	if hasFile(snapshot, reviewcore.SideNew, "sub") {
		t.Fatal("a submodule has no textual content and must not be listed")
	}
	reader := mustOpen(t, repo, snapshot)
	if _, err := reader.ReadFile(context.Background(), "sub", reviewcore.SideNew); !reviewcore.IsCode(err, reviewcore.CodePathOutOfScope) {
		t.Fatalf("submodule must be unreadable: %v", err)
	}
}

func TestRepositoryHelpersRejectUnknownRevisions(t *testing.T) {
	tr := newTestRepo(t)
	tr.write("a.txt", "a\n")
	tr.commit("base")
	repo := tr.newRepo(Options{})
	ctx := context.Background()

	_, err := repo.diffChanges(ctx, "bad-revision", "other-revision", "range")
	requireCode(t, err, reviewcore.CodeGitFailure)

	_, err = repo.listTree(ctx, "bad-revision")
	requireCode(t, err, reviewcore.CodeGitFailure)

	_, err = repo.firstParent(ctx, "bad-revision")
	requireCode(t, err, reviewcore.CodeGitFailure)
}

func TestNewRejectsUncreatableStateDir(t *testing.T) {
	tr := newTestRepo(t)
	tr.write("a.txt", "a\n")
	tr.commit("base")
	blocker := filepath.Join(t.TempDir(), "blocker")
	if err := os.WriteFile(blocker, []byte("x"), 0o644); err != nil {
		t.Fatalf("write blocker: %v", err)
	}
	_, err := New(tr.dir, filepath.Join(blocker, "state"), Options{})
	if !reviewcore.IsCode(err, reviewcore.CodePreparationFailed) && !reviewcore.IsCode(err, reviewcore.CodeInvalidInput) {
		t.Fatalf("unusable state directory must be rejected, got %v", err)
	}
}

func TestReaderReadLinesReportsMissingCopy(t *testing.T) {
	tr := newTestRepo(t)
	tr.write("a.txt", "one\n")
	tr.commit("base")
	tr.write("a.txt", "two\n")
	repo := tr.newRepo(Options{})
	snapshot := prepareInput(t, repo, reviewcore.InputSpec{Mode: reviewcore.ModeWorkspace})
	reader := mustOpen(t, repo, snapshot)
	if err := os.Remove(filepath.Join(repo.snapshotDir(snapshot.ID), newSideDirName, copyName("a.txt"))); err != nil {
		t.Fatalf("remove copy: %v", err)
	}
	_, err := reader.ReadLines(context.Background(), "a.txt", reviewcore.SideNew)
	requireCode(t, err, reviewcore.CodeSnapshotMissing)
}
