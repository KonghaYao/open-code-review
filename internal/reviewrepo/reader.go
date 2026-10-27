// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package reviewrepo

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/KonghaYao/open-code-review/internal/reviewcore"
)

// snapshotReader serves one frozen snapshot. All git reads target fixed object
// IDs, never a ref, so a later commit cannot change what a review sees.
type snapshotReader struct {
	repo     *Repo
	snapshot *reviewcore.Snapshot
	files    map[string]reviewcore.FileRecord
	changes  map[string]reviewcore.Change
	paths    map[string][]string
}

var _ reviewcore.Reader = (*snapshotReader)(nil)

// Open validates that the snapshot still exists on disk and returns a reader
// bound to it. The persisted paths are ignored on purpose: the state directory
// of this Repo is the only trusted location.
func (r *Repo) Open(snapshot *reviewcore.Snapshot) (reviewcore.Reader, error) {
	if snapshot == nil {
		return nil, reviewcore.Errorf(reviewcore.CodeInvalidInput, "snapshot is required")
	}
	if !strings.HasPrefix(snapshot.ID, "snap_") || len(snapshot.ID) == len("snap_") {
		return nil, reviewcore.Errorf(reviewcore.CodeInvalidInput, "invalid snapshot id")
	}
	if snapshot.RepoRoot != r.root {
		return nil, reviewcore.Errorf(reviewcore.CodeInvalidInput, "snapshot belongs to a different repository")
	}
	meta, err := os.ReadFile(filepath.Join(r.snapshotDir(snapshot.ID), snapshotFileName))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, reviewcore.Errorf(reviewcore.CodeSnapshotMissing, "snapshot %s is no longer available", snapshot.ID)
		}
		return nil, reviewcore.Errorf(reviewcore.CodeStateCorrupt, "read snapshot metadata: %v", err)
	}
	var stored struct {
		ID string `json:"snapshot_id"`
	}
	if err := json.Unmarshal(meta, &stored); err != nil || stored.ID != snapshot.ID {
		return nil, reviewcore.Errorf(reviewcore.CodeStateCorrupt, "snapshot metadata does not match %s", snapshot.ID)
	}

	reader := &snapshotReader{
		repo:     r,
		snapshot: snapshot,
		files:    make(map[string]reviewcore.FileRecord, len(snapshot.Files)),
		changes:  make(map[string]reviewcore.Change, len(snapshot.Changes)),
		paths:    map[string][]string{reviewcore.SideOld: nil, reviewcore.SideNew: nil},
	}
	for _, record := range snapshot.Files {
		if record.Side != reviewcore.SideOld && record.Side != reviewcore.SideNew {
			continue
		}
		if record.Path == "" || reviewcore.IsSecretPath(record.Path) || reviewcore.IsProviderPath(record.Path) {
			continue
		}
		key := fileKey(record.Side, record.Path)
		if _, exists := reader.files[key]; exists {
			continue
		}
		reader.files[key] = record
	}
	for _, record := range reader.files {
		reader.paths[record.Side] = append(reader.paths[record.Side], record.Path)
	}
	for side := range reader.paths {
		sort.Strings(reader.paths[side])
	}
	for _, change := range snapshot.Changes {
		reader.changes[change.ID] = change
	}
	return reader, nil
}

func fileKey(side, path string) string { return side + "\x00" + path }

func (rd *snapshotReader) lookup(path, side string) (reviewcore.FileRecord, error) {
	path = normalizeRepoPath(path)
	if path == "" {
		return reviewcore.FileRecord{}, reviewcore.Errorf(reviewcore.CodeInvalidArgument, "path is required")
	}
	if side == "" {
		side = reviewcore.SideNew
	}
	if side != reviewcore.SideOld && side != reviewcore.SideNew {
		return reviewcore.FileRecord{}, reviewcore.Errorf(reviewcore.CodeInvalidArgument, "side must be old or new")
	}
	if reviewcore.IsSecretPath(path) {
		return reviewcore.FileRecord{}, reviewcore.Errorf(reviewcore.CodeSecretPath, "secret paths are never readable")
	}
	if reviewcore.IsProviderPath(path) {
		return reviewcore.FileRecord{}, reviewcore.Errorf(reviewcore.CodePathOutOfScope, "path is outside the reviewable snapshot")
	}
	record, ok := rd.files[fileKey(side, path)]
	if !ok {
		return reviewcore.FileRecord{}, reviewcore.Errorf(reviewcore.CodePathOutOfScope, "path is not part of the snapshot")
	}
	return record, nil
}

// loadContent resolves one record to bytes. A git digest names a fixed blob; a
// sha256 digest names a frozen workspace copy.
func (rd *snapshotReader) loadContent(ctx context.Context, record reviewcore.FileRecord) ([]byte, error) {
	if object, ok := strings.CutPrefix(record.Digest, "git:"); ok {
		return rd.repo.readBlob(ctx, object)
	}
	if record.Digest == "" {
		return nil, reviewcore.Errorf(reviewcore.CodeSnapshotMissing, "content for %s is not stored", record.Path)
	}
	return rd.repo.readSnapshotCopy(rd.snapshot.ID, record.Path)
}

func (rd *snapshotReader) ReadFile(ctx context.Context, path, side string) (reviewcore.FileContent, error) {
	record, err := rd.lookup(path, side)
	if err != nil {
		return reviewcore.FileContent{}, err
	}
	content := reviewcore.FileContent{
		Path:     record.Path,
		Side:     record.Side,
		Digest:   record.Digest,
		Binary:   record.Binary,
		TooLarge: record.TooLarge,
	}
	if record.Binary || record.TooLarge {
		return content, nil
	}
	data, err := rd.loadContent(ctx, record)
	if err != nil {
		return reviewcore.FileContent{}, err
	}
	if isBinaryContent(data) {
		content.Binary = true
		return content, nil
	}
	lines, trailing := splitContentLines(data)
	content.Lines = lines
	content.TotalLines = len(lines)
	content.Content = strings.Join(lines, "\n")
	if trailing {
		content.Content += "\n"
	}
	return content, nil
}

func (rd *snapshotReader) ReadFileLines(ctx context.Context, path, side string, startLine, maxLines int) (reviewcore.FileChunk, error) {
	record, err := rd.lookup(path, side)
	if err != nil {
		return reviewcore.FileChunk{}, err
	}
	chunk := reviewcore.FileChunk{
		Path:   record.Path,
		Side:   record.Side,
		Digest: record.Digest,
		Binary: record.Binary,
	}
	if record.Binary {
		return chunk, nil
	}
	if record.TooLarge {
		return reviewcore.FileChunk{}, reviewcore.Errorf(reviewcore.CodePayloadTooLarge, "file is larger than the readable limit")
	}
	data, err := rd.loadContent(ctx, record)
	if err != nil {
		return reviewcore.FileChunk{}, err
	}
	if isBinaryContent(data) {
		chunk.Binary = true
		return chunk, nil
	}
	lines, _ := splitContentLines(data)
	total := len(lines)
	chunk.TotalLines = total

	start := startLine
	if start < 1 {
		start = 1
	}
	if start-1 > total {
		start = total + 1
	}
	end := total
	if maxLines > 0 && start-1+maxLines < total {
		end = start - 1 + maxLines
	}
	if end < start-1 {
		end = start - 1
	}
	chunk.LineStart = start
	chunk.LineEnd = end
	if start-1 < total {
		chunk.Content = strings.Join(lines[start-1:end], "\n")
	}
	return chunk, nil
}

func (rd *snapshotReader) ReadLines(ctx context.Context, path, side string) ([]string, error) {
	record, err := rd.lookup(path, side)
	if err != nil {
		return nil, err
	}
	if record.Binary {
		return nil, reviewcore.Errorf(reviewcore.CodeBinaryFile, "file is binary and cannot be read as text")
	}
	if record.TooLarge {
		return nil, reviewcore.Errorf(reviewcore.CodePayloadTooLarge, "file is larger than the readable limit")
	}
	data, err := rd.loadContent(ctx, record)
	if err != nil {
		return nil, err
	}
	if isBinaryContent(data) {
		return nil, reviewcore.Errorf(reviewcore.CodeBinaryFile, "file is binary and cannot be read as text")
	}
	lines, _ := splitContentLines(data)
	return lines, nil
}

func (rd *snapshotReader) Diff(_ context.Context, changeID string) (string, error) {
	change, ok := rd.changes[changeID]
	if !ok {
		return "", reviewcore.Errorf(reviewcore.CodeInvalidArgument, "unknown change_id")
	}
	return change.Diff, nil
}

func (rd *snapshotReader) UnitDiff(ctx context.Context, unit reviewcore.Unit) (string, error) {
	if len(unit.ChangeIDs) == 0 {
		return "", reviewcore.Errorf(reviewcore.CodeInvalidArgument, "unit has no changes")
	}
	var out strings.Builder
	for _, id := range unit.ChangeIDs {
		change, ok := rd.changes[id]
		if !ok {
			continue
		}
		text, err := rd.renderChange(ctx, change, unit)
		if err != nil {
			return "", err
		}
		if text == "" {
			continue
		}
		if out.Len() > 0 {
			out.WriteString("\n")
		}
		out.WriteString(text)
	}
	return truncateText(out.String(), rd.repo.opts.MaxDiffBytes), nil
}

func (rd *snapshotReader) renderChange(ctx context.Context, change reviewcore.Change, unit reviewcore.Unit) (string, error) {
	if unit.Kind == reviewcore.UnitCrossFile || unit.FullFile || len(unit.Slices) == 0 {
		if change.Diff != "" {
			return change.Diff, nil
		}
		return rd.renderWholeFile(ctx, change)
	}
	return rd.renderSlices(change, unit.Slices), nil
}

func (rd *snapshotReader) renderSlices(change reviewcore.Change, slices []reviewcore.HunkSlice) string {
	var out strings.Builder
	writeDiffHeader(&out, change)
	ordered := append([]reviewcore.HunkSlice(nil), slices...)
	sort.Slice(ordered, func(i, j int) bool {
		if ordered[i].HunkIndex != ordered[j].HunkIndex {
			return ordered[i].HunkIndex < ordered[j].HunkIndex
		}
		return ordered[i].Start < ordered[j].Start
	})
	for _, slice := range ordered {
		if slice.HunkIndex < 0 || slice.HunkIndex >= len(change.Hunks) {
			continue
		}
		hunk := change.Hunks[slice.HunkIndex]
		start := slice.Start
		end := slice.End
		if start < 0 {
			start = 0
		}
		if end > len(hunk.Lines) {
			end = len(hunk.Lines)
		}
		if start >= end {
			continue
		}
		out.WriteString(hunk.Header)
		out.WriteString("\n")
		for _, line := range hunk.Lines[start:end] {
			out.WriteString(line)
			out.WriteString("\n")
		}
	}
	return strings.TrimSuffix(out.String(), "\n")
}

// renderWholeFile is the fallback for a change whose diff text is empty, such
// as an untracked file that could not be inspected.
func (rd *snapshotReader) renderWholeFile(ctx context.Context, change reviewcore.Change) (string, error) {
	side := reviewcore.SideNew
	prefix := "+"
	path := change.NewPath
	if path == "" {
		side = reviewcore.SideOld
		prefix = "-"
		path = change.OldPath
	}
	if path == "" {
		return "", nil
	}
	record, err := rd.lookup(path, side)
	if err != nil || record.Binary || record.TooLarge {
		return "", nil
	}
	data, err := rd.loadContent(ctx, record)
	if err != nil {
		return "", err
	}
	if isBinaryContent(data) {
		return "", nil
	}
	lines, _ := splitContentLines(data)
	var out strings.Builder
	writeDiffHeader(&out, change)
	for _, line := range lines {
		out.WriteString(prefix)
		out.WriteString(line)
		out.WriteString("\n")
	}
	return strings.TrimSuffix(out.String(), "\n"), nil
}

func writeDiffHeader(out *strings.Builder, change reviewcore.Change) {
	oldPath := change.OldPath
	if oldPath == "" {
		oldPath = change.NewPath
	}
	newPath := change.NewPath
	if newPath == "" {
		newPath = change.OldPath
	}
	fmt.Fprintf(out, "diff --git %s %s\n", quoteGitPath("a/"+oldPath), quoteGitPath("b/"+newPath))
	if change.OldPath == "" {
		out.WriteString("--- /dev/null\n")
	} else {
		fmt.Fprintf(out, "--- %s\n", quoteGitPath("a/"+change.OldPath))
	}
	if change.NewPath == "" {
		out.WriteString("+++ /dev/null\n")
	} else {
		fmt.Fprintf(out, "+++ %s\n", quoteGitPath("b/"+change.NewPath))
	}
}

func (rd *snapshotReader) Search(ctx context.Context, options reviewcore.SearchOptions) ([]reviewcore.SearchMatch, int, int, int, error) {
	query := strings.TrimSpace(options.Query)
	if query == "" {
		return nil, 0, 0, 0, reviewcore.Errorf(reviewcore.CodeInvalidArgument, "query is required")
	}
	side := options.Side
	if side == "" {
		side = reviewcore.SideNew
	}
	if side != reviewcore.SideOld && side != reviewcore.SideNew {
		return nil, 0, 0, 0, reviewcore.Errorf(reviewcore.CodeInvalidArgument, "side must be old or new")
	}
	prefix := normalizeRepoPath(options.PathPrefix)

	match, err := lineMatcher(query, options.Regex, options.CaseSensitive)
	if err != nil {
		return nil, 0, 0, 0, err
	}

	offset := options.Offset
	if offset < 0 {
		offset = 0
	}
	limit := options.Limit
	if limit <= 0 {
		limit = 100
	}
	if limit > 1000 {
		limit = 1000
	}

	var matches []reviewcore.SearchMatch
	total, scanned, skipped := 0, 0, 0
	for _, path := range rd.paths[side] {
		if prefix != "" && !strings.HasPrefix(path, prefix) {
			continue
		}
		record := rd.files[fileKey(side, path)]
		if record.Binary || record.TooLarge {
			skipped++
			continue
		}
		data, loadErr := rd.loadContent(ctx, record)
		if loadErr != nil {
			if reviewcore.IsCode(loadErr, reviewcore.CodeSnapshotMissing) {
				return nil, 0, 0, 0, loadErr
			}
			skipped++
			continue
		}
		if isBinaryContent(data) {
			skipped++
			continue
		}
		scanned++
		lines, _ := splitContentLines(data)
		for i, line := range lines {
			if !match(line) {
				continue
			}
			if total >= offset && len(matches) < limit {
				matches = append(matches, reviewcore.SearchMatch{
					Path:    path,
					Side:    side,
					Line:    i + 1,
					EndLine: i + 1,
					Excerpt: excerpt(line),
					Digest:  record.Digest,
				})
			}
			total++
		}
	}
	return matches, total, scanned, skipped, nil
}

func lineMatcher(query string, regex, caseSensitive bool) (func(string) bool, error) {
	if regex {
		pattern := query
		if !caseSensitive {
			pattern = "(?i)" + pattern
		}
		compiled, err := regexp.Compile(pattern)
		if err != nil {
			return nil, reviewcore.Errorf(reviewcore.CodeInvalidArgument, "invalid regular expression: %v", err)
		}
		return compiled.MatchString, nil
	}
	needle := query
	if !caseSensitive {
		needle = strings.ToLower(needle)
	}
	return func(line string) bool {
		if !caseSensitive {
			line = strings.ToLower(line)
		}
		return strings.Contains(line, needle)
	}, nil
}

func excerpt(line string) string {
	line = strings.TrimSpace(line)
	if len(line) <= 240 {
		return line
	}
	cut := 240
	for cut > 0 && !utf8Boundary(line, cut) {
		cut--
	}
	return line[:cut]
}

// utf8Boundary reports whether index starts a new UTF-8 rune.
func utf8Boundary(text string, index int) bool {
	return index <= 0 || index >= len(text) || text[index]&0xc0 != 0x80
}

func (rd *snapshotReader) ListFiles(_ context.Context, side, prefix string, offset, limit int) ([]reviewcore.FileInfo, int, error) {
	if side == "" {
		side = reviewcore.SideNew
	}
	if side != reviewcore.SideOld && side != reviewcore.SideNew {
		return nil, 0, reviewcore.Errorf(reviewcore.CodeInvalidArgument, "side must be old or new")
	}
	prefix = normalizeRepoPath(prefix)
	paths := rd.paths[side]
	if prefix != "" {
		filtered := make([]string, 0, len(paths))
		for _, path := range paths {
			if strings.HasPrefix(path, prefix) {
				filtered = append(filtered, path)
			}
		}
		paths = filtered
	}
	total := len(paths)
	if offset < 0 {
		offset = 0
	}
	if offset > total {
		offset = total
	}
	if limit <= 0 {
		limit = 200
	}
	if limit > 1000 {
		limit = 1000
	}
	end := offset + limit
	if end > total {
		end = total
	}
	files := make([]reviewcore.FileInfo, 0, end-offset)
	for _, path := range paths[offset:end] {
		record := rd.files[fileKey(side, path)]
		files = append(files, reviewcore.FileInfo{
			Path:   record.Path,
			Side:   record.Side,
			Digest: record.Digest,
			Size:   record.Size,
			Binary: record.Binary,
		})
	}
	return files, total, nil
}

func truncateText(text string, maxBytes int) string {
	if maxBytes <= 0 || len(text) <= maxBytes {
		return text
	}
	cut := maxBytes
	for cut > 0 && text[cut-1] != '\n' {
		cut--
	}
	if cut == 0 {
		cut = maxBytes
		for cut > 0 && !utf8Boundary(text, cut) {
			cut--
		}
	}
	return strings.TrimSuffix(text[:cut], "\n")
}
