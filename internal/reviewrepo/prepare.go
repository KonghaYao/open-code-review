// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package reviewrepo

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/KonghaYao/open-code-review/internal/reviewcore"
)

// Prepare freezes one input mode into an immutable snapshot. Scope is applied
// later by reviewcore.PlanUnits, so it does not change frozen content.
func (r *Repo) Prepare(ctx context.Context, input reviewcore.InputSpec, scope reviewcore.Scope) (*reviewcore.Snapshot, error) {
	_ = scope
	normalized, err := reviewcore.NormalizeInput(&input)
	if err != nil {
		return nil, err
	}
	switch normalized.Mode {
	case reviewcore.ModeRange:
		return r.prepareRange(ctx, normalized)
	case reviewcore.ModeCommit:
		return r.prepareCommit(ctx, normalized)
	case reviewcore.ModeWorkspace:
		return r.prepareWorkspace(ctx, normalized)
	default:
		return nil, reviewcore.Errorf(reviewcore.CodeInvalidInput, "unknown input mode %q", normalized.Mode)
	}
}

// snapshotDraft is everything collected for one snapshot before it gets an ID
// and is written to disk.
type snapshotDraft struct {
	mode         string
	input        reviewcore.InputSpec
	baseSHA      string
	headSHA      string
	mergeBaseSHA string
	changes      []reviewcore.Change
	oldFiles     []reviewcore.FileRecord
	newFiles     []reviewcore.FileRecord
	excluded     []reviewcore.ExcludedEntry
}

func (r *Repo) prepareRange(ctx context.Context, input reviewcore.InputSpec) (*reviewcore.Snapshot, error) {
	from, err := r.resolveCommit(ctx, input.From)
	if err != nil {
		return nil, err
	}
	head, err := r.resolveCommit(ctx, input.To)
	if err != nil {
		return nil, err
	}
	mergeBase, err := r.mergeBase(ctx, from, head)
	if err != nil {
		return nil, err
	}
	changes, err := r.diffChanges(ctx, mergeBase, head, "range")
	if err != nil {
		return nil, err
	}
	oldFiles, oldExcluded, err := r.treeFiles(ctx, mergeBase, reviewcore.SideOld)
	if err != nil {
		return nil, err
	}
	newFiles, newExcluded, err := r.treeFiles(ctx, head, reviewcore.SideNew)
	if err != nil {
		return nil, err
	}
	draft := snapshotDraft{
		mode:         reviewcore.ModeRange,
		input:        input,
		baseSHA:      mergeBase,
		headSHA:      head,
		mergeBaseSHA: mergeBase,
		changes:      changes,
		oldFiles:     oldFiles,
		newFiles:     newFiles,
		excluded:     append(oldExcluded, newExcluded...),
	}
	return r.finish(draft)
}

func (r *Repo) prepareCommit(ctx context.Context, input reviewcore.InputSpec) (*reviewcore.Snapshot, error) {
	head, err := r.resolveCommit(ctx, input.Commit)
	if err != nil {
		return nil, err
	}
	parent, err := r.firstParent(ctx, head)
	if err != nil {
		return nil, err
	}
	// A root commit compares against the empty tree, which git resolves even
	// when the object is not stored in the repository.
	base := parent
	if base == "" {
		base = emptyTreeSHA
	}
	changes, err := r.diffChanges(ctx, base, head, "commit")
	if err != nil {
		return nil, err
	}
	oldFiles, oldExcluded, err := r.treeFiles(ctx, parent, reviewcore.SideOld)
	if err != nil {
		return nil, err
	}
	newFiles, newExcluded, err := r.treeFiles(ctx, head, reviewcore.SideNew)
	if err != nil {
		return nil, err
	}
	draft := snapshotDraft{
		mode:     reviewcore.ModeCommit,
		input:    input,
		baseSHA:  base,
		headSHA:  head,
		changes:  changes,
		oldFiles: oldFiles,
		newFiles: newFiles,
		excluded: append(oldExcluded, newExcluded...),
	}
	return r.finish(draft)
}

func (r *Repo) prepareWorkspace(ctx context.Context, input reviewcore.InputSpec) (*reviewcore.Snapshot, error) {
	head, err := r.headCommit(ctx)
	if err != nil {
		return nil, err
	}

	before, err := r.workspaceState(ctx)
	if err != nil {
		return nil, err
	}

	staging, err := os.MkdirTemp(filepath.Join(r.stateDir, snapshotsDirName), ".staging-*")
	if err != nil {
		return nil, reviewcore.Errorf(reviewcore.CodePreparationFailed, "create staging directory: %v", err)
	}
	defer os.RemoveAll(staging)

	var diffArgs []string
	if head != "" {
		diffArgs = []string{"diff", "--no-color", "--no-ext-diff", "--no-textconv", "--find-renames", "--src-prefix=a/", "--dst-prefix=b/", head, "--"}
	} else {
		// An unborn HEAD has no tree to compare against; the index already
		// contains the staged content relative to the empty tree.
		diffArgs = []string{"diff", "--cached", "--no-color", "--no-ext-diff", "--no-textconv", "--find-renames", "--src-prefix=a/", "--dst-prefix=b/", "--"}
	}
	rawDiff, err := r.git(ctx, diffArgs...)
	if err != nil {
		return nil, err
	}
	blocks := parseUnifiedDiff(string(rawDiff), r.opts.MaxDiffBytes)
	changes := changesFromBlocks(blocks, "workspace")
	tracked := make(map[string]bool, len(changes))
	for _, change := range changes {
		if change.NewPath != "" {
			tracked[change.NewPath] = true
		}
	}
	for _, path := range before.untracked {
		if tracked[path] {
			continue
		}
		changes = append(changes, reviewcore.Change{
			ID:      changeID("untracked", statusAdded, "", path),
			Status:  statusAdded,
			NewPath: path,
			Source:  "untracked",
			IsTest:  reviewcore.IsTestPath(path),
		})
	}
	sort.SliceStable(changes, func(i, j int) bool {
		// Untracked additions go after the tracked diff so the order stays
		// stable for a given worktree state.
		if changes[i].Source != changes[j].Source {
			return changes[i].Source == "workspace"
		}
		return false
	})

	oldFiles, oldExcluded, err := r.treeFiles(ctx, head, reviewcore.SideOld)
	if err != nil {
		return nil, err
	}
	newByPath := make(map[string]reviewcore.FileRecord, len(oldFiles))
	for _, record := range oldFiles {
		// The new side of an unchanged file is the same HEAD blob, but the
		// record must be tagged with the side it is asked for.
		record.Side = reviewcore.SideNew
		newByPath[record.Path] = record
	}
	var excluded []reviewcore.ExcludedEntry
	excluded = append(excluded, oldExcluded...)

	for i := range changes {
		change := &changes[i]
		if change.OldPath != "" && change.OldPath != change.NewPath {
			delete(newByPath, change.OldPath)
		}
		if change.NewPath == "" {
			continue
		}
		record, freezeErr := r.freezeWorkspaceNewSide(ctx, staging, change)
		if freezeErr != nil {
			return nil, freezeErr
		}
		if record == nil {
			delete(newByPath, change.NewPath)
			continue
		}
		newByPath[change.NewPath] = *record
	}

	newFiles := make([]reviewcore.FileRecord, 0, len(newByPath))
	for _, record := range newByPath {
		newFiles = append(newFiles, record)
	}
	sortFileRecords(newFiles)

	after, err := r.workspaceState(ctx)
	if err != nil {
		return nil, err
	}
	// The worktree is the only mutable input. A stable fingerprint across
	// collection proves the stored copies match the diff we parsed.
	if before.fingerprint != after.fingerprint {
		return nil, reviewcore.Errorf(reviewcore.CodeInputChanged, "workspace changed while the snapshot was being prepared")
	}

	draft := snapshotDraft{
		mode:     reviewcore.ModeWorkspace,
		input:    input,
		baseSHA:  head,
		headSHA:  head,
		changes:  changes,
		oldFiles: oldFiles,
		newFiles: newFiles,
		excluded: excluded,
	}
	return r.finishWithStaging(draft, staging)
}

// freezeWorkspaceNewSide copies one new-side file into the staging area and
// fills the change's diff and digest. It returns nil when the path must not
// appear on the new side at all (secret, provider, submodule, vanished file).
func (r *Repo) freezeWorkspaceNewSide(ctx context.Context, staging string, change *reviewcore.Change) (*reviewcore.FileRecord, error) {
	path := change.NewPath
	if reviewcore.IsSecretPath(path) {
		// A secret path must never be read, so its diff text cannot be frozen
		// either; the change stays in the manifest only as an exclusion.
		change.Diff = ""
		change.Hunks = nil
		change.Insertions = 0
		change.Deletions = 0
		change.Binary = false
		return nil, nil
	}
	if reviewcore.IsProviderPath(path) {
		return nil, nil
	}
	full := filepath.Join(r.root, filepath.FromSlash(path))
	info, err := os.Lstat(full)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, reviewcore.Errorf(reviewcore.CodePreparationFailed, "inspect %s: %v", path, err)
	}

	var data []byte
	switch {
	case info.Mode()&os.ModeSymlink != 0:
		target, readErr := os.Readlink(full)
		if readErr != nil {
			return nil, reviewcore.Errorf(reviewcore.CodePreparationFailed, "read link %s: %v", path, readErr)
		}
		data = []byte(target)
	case info.Mode().IsRegular():
		if info.Size() > int64(r.opts.MaxFileBytes) {
			return &reviewcore.FileRecord{Path: path, Side: reviewcore.SideNew, Size: info.Size(), TooLarge: true}, nil
		}
		data, err = os.ReadFile(full)
		if err != nil {
			return nil, reviewcore.Errorf(reviewcore.CodePreparationFailed, "read %s: %v", path, err)
		}
	default:
		return nil, nil
	}

	record := &reviewcore.FileRecord{
		Path:   path,
		Side:   reviewcore.SideNew,
		Size:   int64(len(data)),
		Digest: reviewcore.HashBytes(data),
	}
	change.NewDigest = record.Digest
	if isBinaryContent(data) {
		record.Binary = true
		change.Binary = true
		if change.Source == "untracked" {
			applySyntheticDiff(change, syntheticBinaryDiff(path), r.opts.MaxDiffBytes)
		}
		return record, nil
	}
	if change.Source == "untracked" {
		applySyntheticDiff(change, syntheticAddDiff(path, data), r.opts.MaxDiffBytes)
	}
	if err := os.WriteFile(filepath.Join(staging, copyName(path)), data, 0o600); err != nil {
		return nil, reviewcore.Errorf(reviewcore.CodePreparationFailed, "stage snapshot copy: %v", err)
	}
	return record, nil
}

// workspaceState fingerprints the mutable worktree. Content digests are read
// for ordinary files; secret paths contribute only metadata so the fingerprint
// never touches their bytes.
type workspaceState struct {
	fingerprint string
	untracked   []string
}

type statusEntry struct {
	code string
	path string
}

func (r *Repo) workspaceState(ctx context.Context) (workspaceState, error) {
	out, err := r.git(ctx, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames")
	if err != nil {
		return workspaceState{}, err
	}
	entries := parseStatus(string(out))
	sort.Slice(entries, func(i, j int) bool { return entries[i].path < entries[j].path })

	var untracked []string
	var buffer strings.Builder
	for _, entry := range entries {
		if entry.code == "??" {
			untracked = append(untracked, entry.path)
		}
		buffer.WriteString(entry.code)
		buffer.WriteByte(0)
		buffer.WriteString(entry.path)
		buffer.WriteByte(0)
		buffer.WriteString(r.contentFingerprint(entry.path))
		buffer.WriteByte(0)
	}
	return workspaceState{
		fingerprint: reviewcore.HashString(buffer.String()),
		untracked:   untracked,
	}, nil
}

func parseStatus(out string) []statusEntry {
	var entries []statusEntry
	for _, record := range strings.Split(out, "\x00") {
		if len(record) < 4 || record[2] != ' ' {
			continue
		}
		entries = append(entries, statusEntry{code: record[:2], path: record[3:]})
	}
	return entries
}

func (r *Repo) contentFingerprint(path string) string {
	full := filepath.Join(r.root, filepath.FromSlash(path))
	if reviewcore.IsSecretPath(path) {
		info, err := os.Lstat(full)
		if err != nil {
			return "secret:absent"
		}
		return "secret:" + strconv.FormatInt(info.Size(), 10) + ":" + strconv.FormatInt(info.ModTime().UnixNano(), 10)
	}
	info, err := os.Lstat(full)
	if err != nil {
		return "absent"
	}
	switch {
	case info.Mode()&os.ModeSymlink != 0:
		target, readErr := os.Readlink(full)
		if readErr != nil {
			return "symlink:error"
		}
		return "symlink:" + reviewcore.HashString(target)
	case !info.Mode().IsRegular():
		return "special:" + info.Mode().Type().String()
	case info.Size() > int64(r.opts.MaxFileBytes):
		return "large:" + strconv.FormatInt(info.Size(), 10) + ":" + strconv.FormatInt(info.ModTime().UnixNano(), 10)
	}
	data, err := os.ReadFile(full)
	if err != nil {
		return "error"
	}
	return reviewcore.HashBytes(data)
}

func (r *Repo) resolveCommit(ctx context.Context, ref string) (string, error) {
	out, err := r.git(ctx, "rev-parse", "--verify", ref+"^{commit}")
	if err != nil {
		return "", err
	}
	sha := strings.TrimSpace(string(out))
	if !isObjectID(sha) {
		return "", reviewcore.Errorf(reviewcore.CodeGitFailure, "cannot resolve %q to a commit", ref)
	}
	return sha, nil
}

func (r *Repo) mergeBase(ctx context.Context, from, to string) (string, error) {
	out, err := r.git(ctx, "merge-base", from, to)
	if err != nil {
		return "", err
	}
	sha := strings.TrimSpace(string(out))
	if !isObjectID(sha) {
		return "", reviewcore.Errorf(reviewcore.CodeGitFailure, "no merge base for the selected commits")
	}
	return sha, nil
}

// headCommit returns an empty string for an unborn branch, which is a valid
// workspace input, and an error only when HEAD itself is broken.
func (r *Repo) headCommit(ctx context.Context) (string, error) {
	out, err := r.git(ctx, "rev-parse", "--verify", "--quiet", "HEAD^{commit}")
	if err == nil {
		sha := strings.TrimSpace(string(out))
		if isObjectID(sha) {
			return sha, nil
		}
		return "", nil
	}
	if _, symErr := r.git(ctx, "symbolic-ref", "--quiet", "HEAD"); symErr == nil {
		return "", nil
	}
	return "", err
}

func (r *Repo) firstParent(ctx context.Context, sha string) (string, error) {
	out, err := r.git(ctx, "rev-list", "--parents", "-n", "1", sha)
	if err != nil {
		return "", err
	}
	fields := strings.Fields(strings.TrimSpace(string(out)))
	if len(fields) >= 2 {
		return fields[1], nil
	}
	return "", nil
}

func (r *Repo) diffChanges(ctx context.Context, base, head, source string) ([]reviewcore.Change, error) {
	out, err := r.git(ctx, "diff", "--no-color", "--no-ext-diff", "--no-textconv", "--find-renames", "--src-prefix=a/", "--dst-prefix=b/", base, head, "--")
	if err != nil {
		return nil, err
	}
	return changesFromBlocks(parseUnifiedDiff(string(out), r.opts.MaxDiffBytes), source), nil
}

func changesFromBlocks(blocks []diffBlock, source string) []reviewcore.Change {
	changes := make([]reviewcore.Change, 0, len(blocks))
	for _, block := range blocks {
		path := block.newPath
		if path == "" {
			path = block.oldPath
		}
		if path == "" {
			continue
		}
		change := reviewcore.Change{
			ID:            changeID(source, block.status, block.oldPath, block.newPath),
			Status:        block.status,
			OldPath:       block.oldPath,
			NewPath:       block.newPath,
			Source:        source,
			Binary:        block.binary,
			IsTest:        reviewcore.IsTestPath(path),
			Insertions:    block.insertions,
			Deletions:     block.deletions,
			Diff:          block.text,
			DiffTruncated: block.truncated,
			Hunks:         block.hunks,
		}
		if reviewcore.IsSecretPath(path) {
			// git already emitted the bytes, but a snapshot must never store or
			// serve them. The change stays visible only as an exclusion.
			change.Binary = false
			change.Insertions = 0
			change.Deletions = 0
			change.Diff = ""
			change.DiffTruncated = false
			change.Hunks = nil
		}
		changes = append(changes, change)
	}
	return changes
}

func changeID(parts ...string) string {
	h := sha256.New()
	for _, part := range parts {
		_, _ = h.Write([]byte(part))
		_, _ = h.Write([]byte{0})
	}
	return "ch_" + hex.EncodeToString(h.Sum(nil))[:16]
}

func applySyntheticDiff(change *reviewcore.Change, text string, maxBytes int) {
	blocks := parseUnifiedDiff(text, maxBytes)
	if len(blocks) == 0 {
		return
	}
	block := blocks[0]
	change.Diff = block.text
	change.DiffTruncated = block.truncated
	change.Hunks = block.hunks
	change.Insertions = block.insertions
	change.Deletions = block.deletions
	if block.binary {
		change.Binary = true
	}
}

func syntheticAddDiff(path string, data []byte) string {
	lines, _ := splitContentLines(data)
	var b strings.Builder
	fmt.Fprintf(&b, "diff --git %s %s\n", quoteGitPath("a/"+path), quoteGitPath("b/"+path))
	b.WriteString("new file mode 100644\n")
	b.WriteString("--- /dev/null\n")
	fmt.Fprintf(&b, "+++ %s\n", quoteGitPath("b/"+path))
	if len(lines) == 0 {
		return b.String()
	}
	fmt.Fprintf(&b, "@@ -0,0 +1,%d @@\n", len(lines))
	for _, line := range lines {
		b.WriteString("+")
		b.WriteString(line)
		b.WriteString("\n")
	}
	return b.String()
}

func syntheticBinaryDiff(path string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "diff --git %s %s\n", quoteGitPath("a/"+path), quoteGitPath("b/"+path))
	b.WriteString("new file mode 100644\n")
	fmt.Fprintf(&b, "Binary files /dev/null and %s differ\n", quoteGitPath("b/"+path))
	return b.String()
}

func (r *Repo) finish(draft snapshotDraft) (*reviewcore.Snapshot, error) {
	return r.finishWithStaging(draft, "")
}

// finishWithStaging fills cross references, derives a content-bound snapshot
// ID, persists the copies and writes the snapshot metadata.
func (r *Repo) finishWithStaging(draft snapshotDraft, staging string) (*reviewcore.Snapshot, error) {
	oldIndex := indexFiles(draft.oldFiles)
	newIndex := indexFiles(draft.newFiles)

	for i := range draft.changes {
		change := &draft.changes[i]
		if change.OldDigest == "" && change.OldPath != "" {
			change.OldDigest = oldIndex[change.OldPath].Digest
		}
		if change.NewDigest == "" && change.NewPath != "" {
			change.NewDigest = newIndex[change.NewPath].Digest
		}
	}

	excluded := mergeExcluded(draft.excluded, changeExclusions(draft.changes, oldIndex, newIndex))
	files := make([]reviewcore.FileRecord, 0, len(draft.oldFiles)+len(draft.newFiles))
	files = append(files, draft.oldFiles...)
	files = append(files, draft.newFiles...)
	sortFileRecords(files)

	inputDigest, err := reviewcore.CanonicalHash(struct {
		Mode         string `json:"mode"`
		From         string `json:"from,omitempty"`
		To           string `json:"to,omitempty"`
		Commit       string `json:"commit,omitempty"`
		BaseSHA      string `json:"base_sha,omitempty"`
		HeadSHA      string `json:"head_sha,omitempty"`
		MergeBaseSHA string `json:"merge_base_sha,omitempty"`
	}{draft.mode, draft.input.From, draft.input.To, draft.input.Commit, draft.baseSHA, draft.headSHA, draft.mergeBaseSHA})
	if err != nil {
		return nil, err
	}

	id, err := snapshotID(draft, files, excluded)
	if err != nil {
		return nil, err
	}
	dir := r.snapshotDir(id)
	if staging != "" {
		if err := moveStagedCopies(staging, dir); err != nil {
			return nil, err
		}
	} else if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, reviewcore.Errorf(reviewcore.CodePreparationFailed, "create snapshot directory: %v", err)
	}

	snapshot := &reviewcore.Snapshot{
		ID:           id,
		Mode:         draft.mode,
		RepoRoot:     r.root,
		BaseSHA:      draft.baseSHA,
		HeadSHA:      draft.headSHA,
		MergeBaseSHA: draft.mergeBaseSHA,
		InputDigest:  inputDigest,
		Changes:      draft.changes,
		Files:        files,
		Excluded:     excluded,
		CreatedAt:    r.opts.Now().UTC(),
	}
	if draft.mode == reviewcore.ModeWorkspace {
		snapshot.WorkspaceDir = filepath.Join(dir, newSideDirName)
	}
	data, err := marshalSnapshot(snapshot)
	if err != nil {
		return nil, err
	}
	if err := atomicWriteFile(filepath.Join(dir, snapshotFileName), data); err != nil {
		return nil, reviewcore.Errorf(reviewcore.CodePreparationFailed, "write snapshot metadata: %v", err)
	}
	return snapshot, nil
}

func snapshotID(draft snapshotDraft, files []reviewcore.FileRecord, excluded []reviewcore.ExcludedEntry) (string, error) {
	sum, err := reviewcore.CanonicalHash(struct {
		Mode         string                     `json:"mode"`
		BaseSHA      string                     `json:"base_sha,omitempty"`
		HeadSHA      string                     `json:"head_sha,omitempty"`
		MergeBaseSHA string                     `json:"merge_base_sha,omitempty"`
		Changes      []reviewcore.Change        `json:"changes"`
		Files        []reviewcore.FileRecord    `json:"files"`
		Excluded     []reviewcore.ExcludedEntry `json:"excluded,omitempty"`
	}{draft.mode, draft.baseSHA, draft.headSHA, draft.mergeBaseSHA, draft.changes, files, excluded})
	if err != nil {
		return "", err
	}
	sum = strings.TrimPrefix(sum, "sha256:")
	if len(sum) > 32 {
		sum = sum[:32]
	}
	return "snap_" + sum, nil
}

func indexFiles(records []reviewcore.FileRecord) map[string]reviewcore.FileRecord {
	index := make(map[string]reviewcore.FileRecord, len(records))
	for _, record := range records {
		index[record.Path] = record
	}
	return index
}

// changeExclusions records why a changed path is not reviewable. Unchanged
// tree files are already absent from the manifest, so only the change surface
// needs an explanation.
func changeExclusions(changes []reviewcore.Change, oldIndex, newIndex map[string]reviewcore.FileRecord) []reviewcore.ExcludedEntry {
	var excluded []reviewcore.ExcludedEntry
	for _, change := range changes {
		path := changePath(change)
		if path == "" {
			continue
		}
		entry := reviewcore.ExcludedEntry{Path: path, Side: changeSide(change), Source: change.Source}
		switch {
		case reviewcore.IsSecretPath(path):
			entry.Reason = reviewcore.ExcludeSecret
			excluded = append(excluded, entry)
			continue
		case reviewcore.IsProviderPath(path):
			entry.Reason = reviewcore.ExcludeProvider
			excluded = append(excluded, entry)
			continue
		}
		record, ok := newIndex[path]
		if change.NewPath == "" {
			record, ok = oldIndex[change.OldPath]
		}
		if change.Binary || (ok && record.Binary) {
			entry.Reason = reviewcore.ExcludeBinary
			excluded = append(excluded, entry)
		}
		if ok && record.TooLarge {
			entry.Reason = reviewcore.ExcludeTooLarge
			excluded = append(excluded, entry)
		}
	}
	return excluded
}

func moveStagedCopies(staging, dir string) error {
	entries, err := os.ReadDir(staging)
	if err != nil {
		return reviewcore.Errorf(reviewcore.CodePreparationFailed, "read staging directory: %v", err)
	}
	newDir := filepath.Join(dir, newSideDirName)
	if err := os.MkdirAll(newDir, 0o700); err != nil {
		return reviewcore.Errorf(reviewcore.CodePreparationFailed, "create snapshot directory: %v", err)
	}
	for _, entry := range entries {
		source := filepath.Join(staging, entry.Name())
		target := filepath.Join(newDir, entry.Name())
		if _, statErr := os.Stat(target); statErr == nil {
			// A concurrent prepare with identical content already froze this
			// copy; the snapshot ID proves the bytes are the same.
			continue
		}
		if err := os.Rename(source, target); err != nil {
			return reviewcore.Errorf(reviewcore.CodePreparationFailed, "commit snapshot copy: %v", err)
		}
	}
	return nil
}
