// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package reviewrepo

import (
	"context"
	"strings"
	"testing"

	"github.com/KonghaYao/open-code-review/internal/reviewcore"
)

func newSearchFixture(t *testing.T) (*testRepo, *Repo, *reviewcore.Snapshot, reviewcore.Reader) {
	t.Helper()
	tr := newTestRepo(t)
	tr.write("dir/one.txt", "alpha NEEDLE beta\nno match here\n")
	tr.write("dir/two.txt", "needle one\nNEEDLE two\n")
	tr.write("root.txt", "nothing to see\n")
	tr.writeBytes("bin/blob.bin", []byte("needle\x00binary\n"))
	tr.commit("base")

	repo := tr.newRepo(Options{})
	snapshot := prepareInput(t, repo, reviewcore.InputSpec{Mode: reviewcore.ModeCommit, Commit: tr.head()})
	return tr, repo, snapshot, mustOpen(t, repo, snapshot)
}

func TestReaderSearch(t *testing.T) {
	_, _, _, reader := newSearchFixture(t)

	matches, total, scanned, skipped, err := reader.Search(context.Background(), reviewcore.SearchOptions{
		Query: "needle", Side: reviewcore.SideNew, Limit: 10,
	})
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if total != 3 || len(matches) != 3 || scanned != 3 || skipped != 1 {
		t.Fatalf("unexpected search accounting: total=%d matches=%d scanned=%d skipped=%d", total, len(matches), scanned, skipped)
	}
	if matches[0].Path != "dir/one.txt" || matches[0].Line != 1 || matches[0].EndLine != 1 || matches[0].Digest == "" {
		t.Fatalf("unexpected first match: %+v", matches[0])
	}
	if matches[0].Excerpt != "alpha NEEDLE beta" {
		t.Fatalf("unexpected excerpt %q", matches[0].Excerpt)
	}
	if matches[1].Path != "dir/two.txt" || matches[1].Line != 1 || matches[2].Line != 2 {
		t.Fatalf("unexpected match order: %+v", matches)
	}

	matches, total, _, _, err = reader.Search(context.Background(), reviewcore.SearchOptions{
		Query: "needle", CaseSensitive: true, Side: reviewcore.SideNew,
	})
	if err != nil {
		t.Fatalf("Search(case sensitive): %v", err)
	}
	if total != 1 || len(matches) != 1 || matches[0].Line != 1 {
		t.Fatalf("unexpected case-sensitive result: total=%d %+v", total, matches)
	}

	_, total, _, _, err = reader.Search(context.Background(), reviewcore.SearchOptions{
		Query: `needle\s+\w+`, Regex: true, Side: reviewcore.SideNew,
	})
	if err != nil {
		t.Fatalf("Search(regexp): %v", err)
	}
	if total != 3 {
		t.Fatalf("unexpected regexp total %d", total)
	}

	_, total, _, _, err = reader.Search(context.Background(), reviewcore.SearchOptions{
		Query: "needle", PathPrefix: "dir/one", Side: reviewcore.SideNew,
	})
	if err != nil {
		t.Fatalf("Search(prefix): %v", err)
	}
	if total != 1 {
		t.Fatalf("unexpected prefix total %d", total)
	}

	matches, total, _, _, err = reader.Search(context.Background(), reviewcore.SearchOptions{
		Query: "needle", Side: reviewcore.SideNew, Offset: 1, Limit: 1,
	})
	if err != nil {
		t.Fatalf("Search(paged): %v", err)
	}
	if total != 3 || len(matches) != 1 || matches[0].Path != "dir/two.txt" || matches[0].Line != 1 {
		t.Fatalf("unexpected page: total=%d %+v", total, matches)
	}
}

func TestReaderSearchRejectsInvalidQuery(t *testing.T) {
	_, _, _, reader := newSearchFixture(t)
	_, _, _, _, err := reader.Search(context.Background(), reviewcore.SearchOptions{Query: "  "})
	requireCode(t, err, reviewcore.CodeInvalidArgument)

	_, _, _, _, err = reader.Search(context.Background(), reviewcore.SearchOptions{Query: "(", Regex: true})
	requireCode(t, err, reviewcore.CodeInvalidArgument)

	_, _, _, _, err = reader.Search(context.Background(), reviewcore.SearchOptions{Query: "x", Side: "sideways"})
	requireCode(t, err, reviewcore.CodeInvalidArgument)
}

func TestReaderSearchSkipsTooLargeFile(t *testing.T) {
	tr := newTestRepo(t)
	tr.write("small.txt", "needle\n")
	tr.write("big.txt", strings.Repeat("needle padding\n", 20))
	tr.commit("base")

	repo := tr.newRepo(Options{MaxFileBytes: 64})
	snapshot := prepareInput(t, repo, reviewcore.InputSpec{Mode: reviewcore.ModeCommit, Commit: tr.head()})
	reader := mustOpen(t, repo, snapshot)

	matches, total, scanned, skipped, err := reader.Search(context.Background(), reviewcore.SearchOptions{
		Query: "needle", Side: reviewcore.SideNew,
	})
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if total != 1 || len(matches) != 1 || matches[0].Path != "small.txt" {
		t.Fatalf("unexpected matches: total=%d %+v", total, matches)
	}
	if scanned != 1 || skipped != 1 {
		t.Fatalf("unexpected accounting: scanned=%d skipped=%d", scanned, skipped)
	}
}

func TestReaderListFiles(t *testing.T) {
	tr := newTestRepo(t)
	tr.write("a.txt", "a\n")
	tr.write("dir/b.txt", "b\n")
	tr.write("dir/c.txt", "c\n")
	tr.write("z.txt", "z\n")
	base := tr.commit("base")
	tr.write("dir/d.txt", "d\n")
	tr.remove("z.txt")
	head := tr.commit("second")

	repo := tr.newRepo(Options{})
	snapshot := prepareInput(t, repo, reviewcore.InputSpec{Mode: reviewcore.ModeRange, From: base, To: head})
	reader := mustOpen(t, repo, snapshot)

	files, total, err := reader.ListFiles(context.Background(), reviewcore.SideNew, "dir/", 0, 10)
	if err != nil {
		t.Fatalf("ListFiles: %v", err)
	}
	if total != 3 || len(files) != 3 {
		t.Fatalf("unexpected list: total=%d %+v", total, files)
	}
	if files[0].Path != "dir/b.txt" || files[2].Path != "dir/d.txt" || files[0].Side != reviewcore.SideNew {
		t.Fatalf("unexpected ordering: %+v", files)
	}
	if files[0].Digest == "" || files[0].Size == 0 {
		t.Fatalf("file info is incomplete: %+v", files[0])
	}

	files, total, err = reader.ListFiles(context.Background(), reviewcore.SideOld, "dir/", 1, 1)
	if err != nil {
		t.Fatalf("ListFiles(paged): %v", err)
	}
	if total != 2 || len(files) != 1 || files[0].Path != "dir/c.txt" {
		t.Fatalf("unexpected page: total=%d %+v", total, files)
	}

	files, total, err = reader.ListFiles(context.Background(), reviewcore.SideNew, "", 0, 2)
	if err != nil {
		t.Fatalf("ListFiles(all): %v", err)
	}
	if total != 4 || len(files) != 2 {
		t.Fatalf("unexpected first page: total=%d %+v", total, files)
	}

	if _, _, err := reader.ListFiles(context.Background(), "both", "", 0, 10); !reviewcore.IsCode(err, reviewcore.CodeInvalidArgument) {
		t.Fatalf("invalid side must be rejected: %v", err)
	}
}

func TestReaderDiffAndUnitDiff(t *testing.T) {
	tr := newTestRepo(t)
	var base strings.Builder
	for i := 1; i <= 40; i++ {
		base.WriteString("line ")
		base.WriteString(strings.Repeat("x", i%7+1))
		base.WriteString("\n")
	}
	tr.write("a.txt", base.String())
	tr.write("b.txt", "same\n")
	baseSHA := tr.commit("base")

	updated := strings.Replace(base.String(), "line x", "line CHANGED", 1)
	lines := strings.Split(updated, "\n")
	lines[35] = "modified tail"
	tr.write("a.txt", strings.Join(lines, "\n"))
	tr.write("b.txt", "different\n")
	headSHA := tr.commit("change")

	repo := tr.newRepo(Options{})
	snapshot := prepareInput(t, repo, reviewcore.InputSpec{Mode: reviewcore.ModeRange, From: baseSHA, To: headSHA})
	reader := mustOpen(t, repo, snapshot)
	change := findChange(t, snapshot, "a.txt")
	if len(change.Hunks) < 2 {
		t.Fatalf("expected two hunks, got %d", len(change.Hunks))
	}

	diff, err := reader.Diff(context.Background(), change.ID)
	if err != nil {
		t.Fatalf("Diff: %v", err)
	}
	if diff != change.Diff || !strings.Contains(diff, "diff --git a/a.txt b/a.txt") {
		t.Fatalf("unexpected diff text %q", diff)
	}

	full, err := reader.UnitDiff(context.Background(), reviewcore.Unit{
		Kind: reviewcore.UnitFile, ChangeIDs: []string{change.ID}, FullFile: true,
	})
	if err != nil {
		t.Fatalf("UnitDiff(full): %v", err)
	}
	if full != change.Diff {
		t.Fatalf("full unit diff should match the change diff")
	}

	slice, err := reader.UnitDiff(context.Background(), reviewcore.Unit{
		Kind:      reviewcore.UnitFile,
		ChangeIDs: []string{change.ID},
		Slices:    []reviewcore.HunkSlice{{HunkIndex: 0, Start: 0, End: 2}},
	})
	if err != nil {
		t.Fatalf("UnitDiff(slice): %v", err)
	}
	if !strings.Contains(slice, change.Hunks[0].Header) {
		t.Fatalf("slice is missing the hunk header: %q", slice)
	}
	if !strings.Contains(slice, change.Hunks[0].Lines[0]) || !strings.Contains(slice, change.Hunks[0].Lines[1]) {
		t.Fatalf("slice is missing selected lines: %q", slice)
	}
	if strings.Contains(slice, change.Hunks[1].Header) {
		t.Fatalf("slice must not render the other hunk: %q", slice)
	}

	other := findChange(t, snapshot, "b.txt")
	combined, err := reader.UnitDiff(context.Background(), reviewcore.Unit{
		Kind:      reviewcore.UnitCrossFile,
		ChangeIDs: []string{change.ID, other.ID},
	})
	if err != nil {
		t.Fatalf("UnitDiff(cross): %v", err)
	}
	if !strings.Contains(combined, "a/a.txt") || !strings.Contains(combined, "a/b.txt") {
		t.Fatalf("cross-file diff is missing a file: %q", combined)
	}

	if _, err := reader.Diff(context.Background(), "ch_unknown"); !reviewcore.IsCode(err, reviewcore.CodeInvalidArgument) {
		t.Fatalf("unknown change must be rejected: %v", err)
	}
	if _, err := reader.UnitDiff(context.Background(), reviewcore.Unit{}); !reviewcore.IsCode(err, reviewcore.CodeInvalidArgument) {
		t.Fatalf("unit without changes must be rejected: %v", err)
	}
}

func TestReaderReadFileBoundsAndErrors(t *testing.T) {
	tr := newTestRepo(t)
	tr.write("three.txt", "one\ntwo\nthree\n")
	tr.writeBytes("bin.dat", []byte("a\x00b\n"))
	tr.commit("base")

	repo := tr.newRepo(Options{})
	snapshot := prepareInput(t, repo, reviewcore.InputSpec{Mode: reviewcore.ModeCommit, Commit: tr.head()})
	reader := mustOpen(t, repo, snapshot)

	chunk, err := reader.ReadFileLines(context.Background(), "three.txt", reviewcore.SideNew, 2, 2)
	if err != nil {
		t.Fatalf("ReadFileLines: %v", err)
	}
	if chunk.LineStart != 2 || chunk.LineEnd != 3 || chunk.TotalLines != 3 || chunk.Content != "two\nthree" {
		t.Fatalf("unexpected chunk: %+v", chunk)
	}

	chunk, err = reader.ReadFileLines(context.Background(), "three.txt", reviewcore.SideNew, 10, 5)
	if err != nil {
		t.Fatalf("ReadFileLines(past end): %v", err)
	}
	if chunk.Content != "" || chunk.LineStart != 4 || chunk.LineEnd != 3 {
		t.Fatalf("unexpected empty chunk: %+v", chunk)
	}

	lines, err := reader.ReadLines(context.Background(), "three.txt", reviewcore.SideNew)
	if err != nil {
		t.Fatalf("ReadLines: %v", err)
	}
	if len(lines) != 3 || lines[0] != "one" {
		t.Fatalf("unexpected lines: %v", lines)
	}

	binaryChunk, err := reader.ReadFileLines(context.Background(), "bin.dat", reviewcore.SideNew, 1, 10)
	if err != nil {
		t.Fatalf("ReadFileLines(binary): %v", err)
	}
	if !binaryChunk.Binary {
		t.Fatalf("binary chunk was not flagged: %+v", binaryChunk)
	}
	_, err = reader.ReadLines(context.Background(), "bin.dat", reviewcore.SideNew)
	requireCode(t, err, reviewcore.CodeBinaryFile)

	if _, err := reader.ReadFile(context.Background(), ".env", reviewcore.SideNew); !reviewcore.IsCode(err, reviewcore.CodeSecretPath) {
		t.Fatalf("secret path must be refused: %v", err)
	}
	if _, err := reader.ReadFile(context.Background(), "vendor/x.go", reviewcore.SideNew); !reviewcore.IsCode(err, reviewcore.CodePathOutOfScope) {
		t.Fatalf("provider path must be refused: %v", err)
	}
	if _, err := reader.ReadFile(context.Background(), "missing.txt", reviewcore.SideNew); !reviewcore.IsCode(err, reviewcore.CodePathOutOfScope) {
		t.Fatalf("missing path must be refused: %v", err)
	}
	if _, err := reader.ReadFile(context.Background(), "three.txt", "sideways"); !reviewcore.IsCode(err, reviewcore.CodeInvalidArgument) {
		t.Fatalf("invalid side must be refused: %v", err)
	}
	if _, err := reader.ReadFile(context.Background(), "", reviewcore.SideNew); !reviewcore.IsCode(err, reviewcore.CodeInvalidArgument) {
		t.Fatalf("empty path must be refused: %v", err)
	}
}
