// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package reviewrepo

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/KonghaYao/open-code-review/internal/reviewcore"
)

func TestReaderRenderWholeFileFallback(t *testing.T) {
	tr := newTestRepo(t)
	tr.write("a.txt", "one\ntwo\n")
	tr.commit("base")
	repo := tr.newRepo(Options{})
	snapshot := prepareInput(t, repo, reviewcore.InputSpec{Mode: reviewcore.ModeCommit, Commit: tr.head()})

	added := *snapshot
	added.Changes = append([]reviewcore.Change(nil), snapshot.Changes...)
	added.Changes[0].Diff = ""
	added.Changes[0].Hunks = nil
	reader := mustOpen(t, repo, &added)
	out, err := reader.UnitDiff(context.Background(), reviewcore.Unit{
		Kind: reviewcore.UnitFile, ChangeIDs: []string{added.Changes[0].ID}, FullFile: true,
	})
	if err != nil {
		t.Fatalf("UnitDiff: %v", err)
	}
	if !strings.Contains(out, "+++ b/a.txt") || !strings.Contains(out, "+one") || !strings.Contains(out, "+two") {
		t.Fatalf("unexpected fallback rendering: %q", out)
	}

	tr.remove("a.txt")
	deleted := tr.commit("delete")
	rangeSnapshot := prepareInput(t, repo, reviewcore.InputSpec{Mode: reviewcore.ModeRange, From: snapshot.HeadSHA, To: deleted})
	removed := *rangeSnapshot
	removed.Changes = append([]reviewcore.Change(nil), rangeSnapshot.Changes...)
	removed.Changes[0].Diff = ""
	removed.Changes[0].Hunks = nil
	removedReader := mustOpen(t, repo, &removed)
	out, err = removedReader.UnitDiff(context.Background(), reviewcore.Unit{
		Kind: reviewcore.UnitFile, ChangeIDs: []string{removed.Changes[0].ID}, FullFile: true,
	})
	if err != nil {
		t.Fatalf("UnitDiff(deletion): %v", err)
	}
	if !strings.Contains(out, "+++ /dev/null") || !strings.Contains(out, "-one") {
		t.Fatalf("unexpected deletion rendering: %q", out)
	}
}

func TestReaderUnitDiffTruncates(t *testing.T) {
	tr := newTestRepo(t)
	tr.write("a.txt", "one\n")
	tr.commit("base")
	repo := tr.newRepo(Options{MaxDiffBytes: 16})
	snapshot := prepareInput(t, repo, reviewcore.InputSpec{Mode: reviewcore.ModeCommit, Commit: tr.head()})

	copied := *snapshot
	copied.Changes = append([]reviewcore.Change(nil), snapshot.Changes...)
	copied.Changes[0].Diff = strings.Repeat("x", 100)
	copied.Changes[0].Hunks = nil
	reader := mustOpen(t, repo, &copied)
	out, err := reader.UnitDiff(context.Background(), reviewcore.Unit{
		Kind: reviewcore.UnitFile, ChangeIDs: []string{copied.Changes[0].ID}, FullFile: true,
	})
	if err != nil {
		t.Fatalf("UnitDiff: %v", err)
	}
	if len(out) != 16 {
		t.Fatalf("expected a 16-byte rendering, got %d: %q", len(out), out)
	}

	// Unknown changes are skipped rather than failing the whole unit.
	out, err = reader.UnitDiff(context.Background(), reviewcore.Unit{
		Kind: reviewcore.UnitFile, ChangeIDs: []string{"ch_missing"},
	})
	if err != nil || out != "" {
		t.Fatalf("unknown change must be skipped: %q, %v", out, err)
	}
}

func TestReaderExcerptHandlesLongLines(t *testing.T) {
	tr := newTestRepo(t)
	long := "needle " + strings.Repeat("a", 10) + strings.Repeat("\u00e9", 300)
	tr.write("long.txt", long+"\n")
	tr.commit("base")
	repo := tr.newRepo(Options{})
	snapshot := prepareInput(t, repo, reviewcore.InputSpec{Mode: reviewcore.ModeCommit, Commit: tr.head()})
	reader := mustOpen(t, repo, snapshot)

	matches, total, _, _, err := reader.Search(context.Background(), reviewcore.SearchOptions{
		Query: "needle", Side: reviewcore.SideNew,
	})
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if total != 1 || len(matches) != 1 {
		t.Fatalf("unexpected matches: %+v", matches)
	}
	if len(matches[0].Excerpt) > 240 || !utf8.ValidString(matches[0].Excerpt) {
		t.Fatalf("excerpt is not bounded or not valid UTF-8: %d bytes", len(matches[0].Excerpt))
	}
}

func TestReaderOpenDetectsCorruptMetadata(t *testing.T) {
	tr := newTestRepo(t)
	tr.write("a.txt", "one\n")
	tr.commit("base")
	repo := tr.newRepo(Options{})
	snapshot := prepareInput(t, repo, reviewcore.InputSpec{Mode: reviewcore.ModeCommit, Commit: tr.head()})
	metaPath := filepath.Join(repo.snapshotDir(snapshot.ID), snapshotFileName)

	if err := os.WriteFile(metaPath, []byte("{"), 0o644); err != nil {
		t.Fatalf("corrupt metadata: %v", err)
	}
	_, err := repo.Open(snapshot)
	requireCode(t, err, reviewcore.CodeStateCorrupt)

	if err := os.WriteFile(metaPath, []byte(`{"snapshot_id":"snap_other"}`), 0o644); err != nil {
		t.Fatalf("mismatched metadata: %v", err)
	}
	_, err = repo.Open(snapshot)
	requireCode(t, err, reviewcore.CodeStateCorrupt)

	invalid := *snapshot
	invalid.ID = "not-a-snapshot"
	if _, err := repo.Open(&invalid); !reviewcore.IsCode(err, reviewcore.CodeInvalidInput) {
		t.Fatalf("invalid id must be rejected: %v", err)
	}
}

func TestReaderReportsMissingContent(t *testing.T) {
	tr := newTestRepo(t)
	tr.write("a.txt", "one\n")
	tr.write("b.txt", "two\n")
	tr.commit("base")
	repo := tr.newRepo(Options{})
	snapshot := prepareInput(t, repo, reviewcore.InputSpec{Mode: reviewcore.ModeCommit, Commit: tr.head()})

	copied := *snapshot
	copied.Files = append([]reviewcore.FileRecord(nil), snapshot.Files...)
	for i := range copied.Files {
		if copied.Files[i].Path == "a.txt" && copied.Files[i].Side == reviewcore.SideNew {
			copied.Files[i].Digest = ""
		}
	}
	reader := mustOpen(t, repo, &copied)
	_, err := reader.ReadFile(context.Background(), "a.txt", reviewcore.SideNew)
	requireCode(t, err, reviewcore.CodeSnapshotMissing)

	_, _, _, _, err = reader.Search(context.Background(), reviewcore.SearchOptions{Query: "one", Side: reviewcore.SideNew})
	requireCode(t, err, reviewcore.CodeSnapshotMissing)
}

func TestReaderListFilesDefaultLimit(t *testing.T) {
	tr := newTestRepo(t)
	tr.write("a.txt", "a\n")
	tr.write("b.txt", "b\n")
	tr.commit("base")
	repo := tr.newRepo(Options{})
	snapshot := prepareInput(t, repo, reviewcore.InputSpec{Mode: reviewcore.ModeCommit, Commit: tr.head()})
	reader := mustOpen(t, repo, snapshot)

	files, total, err := reader.ListFiles(context.Background(), "", "", 0, 0)
	if err != nil {
		t.Fatalf("ListFiles: %v", err)
	}
	if total != 2 || len(files) != 2 {
		t.Fatalf("unexpected default page: total=%d %+v", total, files)
	}
}
