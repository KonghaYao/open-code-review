// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package reviewrepo

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/KonghaYao/open-code-review/internal/reviewcore"
)

// treeEntry is one blob from `git ls-tree -r`. Submodules surface as commit
// entries and are not readable as text.
type treeEntry struct {
	kind   string
	object string
	size   int64
	path   string
}

func (r *Repo) listTree(ctx context.Context, rev string) ([]treeEntry, error) {
	if rev == "" {
		return nil, nil
	}
	out, err := r.git(ctx, "ls-tree", "-r", "-l", "-z", "--full-tree", rev)
	if err != nil {
		return nil, err
	}
	var entries []treeEntry
	for _, record := range strings.Split(string(out), "\x00") {
		if record == "" {
			continue
		}
		meta, path, ok := strings.Cut(record, "\t")
		if !ok || path == "" {
			continue
		}
		fields := strings.Fields(meta)
		if len(fields) < 4 {
			continue
		}
		size := int64(-1)
		if value := fields[3]; value != "-" {
			size, _ = strconv.ParseInt(value, 10, 64)
		}
		entries = append(entries, treeEntry{
			kind:   fields[1],
			object: fields[2],
			size:   size,
			path:   path,
		})
	}
	return entries, nil
}

// treeFiles enumerates one side of a fixed tree. Secret and provider paths are
// omitted from the manifest entirely so that later reads cannot reach them;
// secret paths stay visible in Excluded because their presence is a security
// fact. Provider directories are a wholesale policy exclusion and are not
// repeated file by file.
func (r *Repo) treeFiles(ctx context.Context, rev, side string) ([]reviewcore.FileRecord, []reviewcore.ExcludedEntry, error) {
	if rev == "" {
		return nil, nil, nil
	}
	entries, err := r.listTree(ctx, rev)
	if err != nil {
		return nil, nil, err
	}
	records := make([]reviewcore.FileRecord, 0, len(entries))
	var excluded []reviewcore.ExcludedEntry
	for _, entry := range entries {
		path := normalizeRepoPath(entry.path)
		if path == "" {
			continue
		}
		if entry.kind != "blob" {
			continue // Submodules have no textual content to freeze.
		}
		if reviewcore.IsSecretPath(path) {
			excluded = append(excluded, reviewcore.ExcludedEntry{
				Path: path, Side: side, Reason: reviewcore.ExcludeSecret,
			})
			continue
		}
		if reviewcore.IsProviderPath(path) {
			continue
		}
		size := entry.size
		if size < 0 {
			size = 0
		}
		records = append(records, reviewcore.FileRecord{
			Path:     path,
			Side:     side,
			Digest:   blobDigest(entry.object),
			Size:     size,
			TooLarge: r.opts.MaxFileBytes > 0 && size > int64(r.opts.MaxFileBytes),
		})
	}
	sortFileRecords(records)
	return records, excluded, nil
}

func blobDigest(object string) string { return "git:" + object }

func isObjectID(value string) bool {
	if len(value) != 40 && len(value) != 64 {
		return false
	}
	for i := 0; i < len(value); i++ {
		c := value[i]
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') && (c < 'A' || c > 'F') {
			return false
		}
	}
	return true
}

func (r *Repo) readBlob(ctx context.Context, object string) ([]byte, error) {
	if !isObjectID(object) {
		return nil, reviewcore.Errorf(reviewcore.CodeInternal, "invalid git object id in snapshot")
	}
	return r.git(ctx, "cat-file", "blob", object)
}

func (r *Repo) readSnapshotCopy(snapshotID, path string) ([]byte, error) {
	data, err := os.ReadFile(filepath.Join(r.snapshotDir(snapshotID), newSideDirName, copyName(path)))
	if err != nil {
		return nil, reviewcore.Errorf(reviewcore.CodeSnapshotMissing, "snapshot copy for %s is missing", path)
	}
	return data, nil
}

// isBinaryContent follows git's own heuristic: a NUL byte early in the file.
func isBinaryContent(data []byte) bool {
	limit := len(data)
	if limit > 8000 {
		limit = 8000
	}
	return bytes.IndexByte(data[:limit], 0) >= 0
}

// splitContentLines normalizes line endings so that line numbers agree with
// what a model sees, while digests stay bound to the raw bytes.
func splitContentLines(data []byte) ([]string, bool) {
	if len(data) == 0 {
		return nil, false
	}
	text := string(data)
	trailing := strings.HasSuffix(text, "\n")
	if trailing {
		text = text[:len(text)-1]
	}
	lines := strings.Split(text, "\n")
	for i := range lines {
		lines[i] = strings.TrimSuffix(lines[i], "\r")
	}
	return lines, trailing
}

// normalizeRepoPath keeps every snapshot path repository-relative and rejects
// anything that could escape the root once joined to a directory.
func normalizeRepoPath(path string) string {
	path = strings.ReplaceAll(path, "\\", "/")
	path = strings.TrimPrefix(path, "./")
	path = strings.TrimPrefix(path, "/")
	if path == "" || path == "." {
		return ""
	}
	for _, part := range strings.Split(path, "/") {
		if part == ".." {
			return ""
		}
	}
	return path
}

func sortFileRecords(records []reviewcore.FileRecord) {
	sort.Slice(records, func(i, j int) bool {
		if records[i].Side != records[j].Side {
			return records[i].Side == reviewcore.SideOld
		}
		return records[i].Path < records[j].Path
	})
}

func mergeExcluded(sets ...[]reviewcore.ExcludedEntry) []reviewcore.ExcludedEntry {
	seen := make(map[string]bool)
	var merged []reviewcore.ExcludedEntry
	for _, set := range sets {
		for _, entry := range set {
			key := entry.Path + "\x00" + entry.Side + "\x00" + entry.Reason
			if seen[key] {
				continue
			}
			seen[key] = true
			merged = append(merged, entry)
		}
	}
	sort.Slice(merged, func(i, j int) bool {
		if merged[i].Path != merged[j].Path {
			return merged[i].Path < merged[j].Path
		}
		if merged[i].Side != merged[j].Side {
			return merged[i].Side < merged[j].Side
		}
		return merged[i].Reason < merged[j].Reason
	})
	return merged
}

// changeSide is the side a change is reported on: deletions only exist in the
// old tree, everything else in the new one.
func changeSide(change reviewcore.Change) string {
	if change.NewPath == "" {
		return reviewcore.SideOld
	}
	return reviewcore.SideNew
}

func changePath(change reviewcore.Change) string {
	if change.NewPath != "" {
		return change.NewPath
	}
	return change.OldPath
}
