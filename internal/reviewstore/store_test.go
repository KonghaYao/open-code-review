// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package reviewstore

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/KonghaYao/open-code-review/internal/reviewcore"
)

func newTestStore(t *testing.T, opts Options) *Store {
	t.Helper()
	store, err := New(filepath.Join(t.TempDir(), "state"), opts)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return store
}

func newTestRun(t *testing.T) *reviewcore.Run {
	t.Helper()
	id, err := reviewcore.NewID("rv_")
	if err != nil {
		t.Fatalf("NewID: %v", err)
	}
	now := time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC)
	return &reviewcore.Run{
		SchemaVersion: reviewcore.SchemaVersion,
		ReviewID:      id,
		Status:        reviewcore.RunActive,
		Requests:      map[string]reviewcore.RequestRecord{},
		CreatedAt:     now,
		UpdatedAt:     now,
		Version:       1,
	}
}

func requireCode(t *testing.T, err error, code reviewcore.ErrorCode) {
	t.Helper()
	if err == nil {
		t.Fatalf("expected %s error, got nil", code)
	}
	if !reviewcore.IsCode(err, code) {
		t.Fatalf("expected code %s, got %v", code, err)
	}
}

func assertNoTempFiles(t *testing.T, root string) {
	t.Helper()
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !entry.IsDir() && strings.HasPrefix(entry.Name(), ".tmp-") {
			t.Errorf("temporary file left behind: %s", path)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk state dir: %v", err)
	}
}

func TestNewCreatesPrivateDirectories(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "nested", "state")
	store, err := New(dir, Options{})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	for _, path := range []string{dir, store.runsDir, store.locksDir} {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatalf("stat %s: %v", path, err)
		}
		if !info.IsDir() {
			t.Fatalf("%s is not a directory", path)
		}
		if perm := info.Mode().Perm(); perm != 0o700 {
			t.Fatalf("%s mode = %o, want 700", path, perm)
		}
	}
}

func TestNewRejectsEmptyDirectory(t *testing.T) {
	for _, dir := range []string{"", "   "} {
		_, err := New(dir, Options{})
		requireCode(t, err, reviewcore.CodeInvalidArgument)
	}
}

func TestNewRejectsFilePath(t *testing.T) {
	file := filepath.Join(t.TempDir(), "state")
	if err := os.WriteFile(file, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := New(file, Options{})
	requireCode(t, err, reviewcore.CodeInternal)
}

func TestCreateRunRoundTrip(t *testing.T) {
	store := newTestStore(t, Options{})
	run := newTestRun(t)

	created, isNew, err := store.CreateRun(context.Background(), run, "key-1", "sha256:hash-1")
	if err != nil {
		t.Fatalf("CreateRun: %v", err)
	}
	if !isNew || created.ReviewID != run.ReviewID {
		t.Fatalf("CreateRun = (%s, %v), want new run %s", created.ReviewID, isNew, run.ReviewID)
	}

	loaded, err := store.LoadRun(context.Background(), run.ReviewID)
	if err != nil {
		t.Fatalf("LoadRun: %v", err)
	}
	if loaded.ReviewID != run.ReviewID || loaded.Version != run.Version || loaded.Status != run.Status {
		t.Fatalf("loaded run = %+v, want %+v", loaded, run)
	}

	for _, path := range []string{store.statePath(run.ReviewID), store.requestsPath} {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatalf("stat %s: %v", path, err)
		}
		if perm := info.Mode().Perm(); perm != 0o600 {
			t.Fatalf("%s mode = %o, want 600", path, perm)
		}
	}
	runDir, err := os.Stat(filepath.Dir(store.statePath(run.ReviewID)))
	if err != nil {
		t.Fatal(err)
	}
	if perm := runDir.Mode().Perm(); perm != 0o700 {
		t.Fatalf("run dir mode = %o, want 700", perm)
	}

	data, err := os.ReadFile(store.requestsPath)
	if err != nil {
		t.Fatal(err)
	}
	var index requestIndex
	if err := json.Unmarshal(data, &index); err != nil {
		t.Fatalf("decode index: %v", err)
	}
	if index.SchemaVersion != requestsSchemaVersion {
		t.Fatalf("index schema = %q", index.SchemaVersion)
	}
	entry, ok := index.Entries[requestKeyDigest("key-1")]
	if !ok {
		t.Fatalf("index entry missing; entries = %v", index.Entries)
	}
	if entry.Key != "key-1" || entry.Hash != "sha256:hash-1" || entry.ReviewID != run.ReviewID {
		t.Fatalf("index entry = %+v", entry)
	}
	assertNoTempFiles(t, store.dir)
}

func TestCreateRunIdempotentReplay(t *testing.T) {
	store := newTestStore(t, Options{})
	run := newTestRun(t)
	first, _, err := store.CreateRun(context.Background(), run, "key-1", "hash-1")
	if err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(store.statePath(first.ReviewID))
	if err != nil {
		t.Fatal(err)
	}

	second, isNew, err := store.CreateRun(context.Background(), newTestRun(t), "key-1", "hash-1")
	if err != nil {
		t.Fatalf("replay: %v", err)
	}
	if isNew {
		t.Fatal("replay reported a new run")
	}
	if second.ReviewID != first.ReviewID || second.Version != first.Version {
		t.Fatalf("replay returned %+v, want %+v", second, first)
	}
	after, err := os.ReadFile(store.statePath(first.ReviewID))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) {
		t.Fatal("replay rewrote the state file")
	}
	assertNoTempFiles(t, store.dir)
}

func TestCreateRunRequestKeyConflict(t *testing.T) {
	store := newTestStore(t, Options{})
	if _, _, err := store.CreateRun(context.Background(), newTestRun(t), "key-1", "hash-1"); err != nil {
		t.Fatal(err)
	}
	_, _, err := store.CreateRun(context.Background(), newTestRun(t), "key-1", "hash-2")
	requireCode(t, err, reviewcore.CodeIdempotencyConflict)
}

func TestCreateRunIndexReferencesMissingRun(t *testing.T) {
	store := newTestStore(t, Options{})
	run := newTestRun(t)
	if _, _, err := store.CreateRun(context.Background(), run, "key-1", "hash-1"); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(filepath.Join(store.runsDir, run.ReviewID)); err != nil {
		t.Fatal(err)
	}

	replacement := newTestRun(t)
	_, _, err := store.CreateRun(context.Background(), replacement, "key-1", "hash-1")
	requireCode(t, err, reviewcore.CodeStateCorrupt)
	if _, loadErr := store.LoadRun(context.Background(), replacement.ReviewID); !reviewcore.IsCode(loadErr, reviewcore.CodeRunNotFound) {
		t.Fatalf("replacement run was created: %v", loadErr)
	}
}

func TestCreateRunExistingStateWithoutIndexEntry(t *testing.T) {
	store := newTestStore(t, Options{})
	run := newTestRun(t)
	statePath := store.statePath(run.ReviewID)
	if err := os.MkdirAll(filepath.Dir(statePath), 0o700); err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(run)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(statePath, data, 0o600); err != nil {
		t.Fatal(err)
	}

	_, _, createErr := store.CreateRun(context.Background(), run, "key-1", "hash-1")
	requireCode(t, createErr, reviewcore.CodeStateCorrupt)
}

func TestCreateRunValidatesInput(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*reviewcore.Run) *reviewcore.Run
		key    string
		code   reviewcore.ErrorCode
	}{
		{"nil run", func(*reviewcore.Run) *reviewcore.Run { return nil }, "key", reviewcore.CodeInvalidArgument},
		{"short id", func(run *reviewcore.Run) *reviewcore.Run { run.ReviewID = "rv_0123456789abcde"; return run }, "key", reviewcore.CodeInvalidArgument},
		{"uppercase id", func(run *reviewcore.Run) *reviewcore.Run {
			run.ReviewID = "rv_" + strings.Repeat("A", 16)
			return run
		}, "key", reviewcore.CodeInvalidArgument},
		{"traversal id", func(run *reviewcore.Run) *reviewcore.Run { run.ReviewID = "rv_../../etc/passwd"; return run }, "key", reviewcore.CodeInvalidArgument},
		{"schema", func(run *reviewcore.Run) *reviewcore.Run { run.SchemaVersion = "peri-code-review/v2"; return run }, "key", reviewcore.CodeInvalidArgument},
		{"version", func(run *reviewcore.Run) *reviewcore.Run { run.Version = 0; return run }, "key", reviewcore.CodeInvalidArgument},
		{"empty key", func(run *reviewcore.Run) *reviewcore.Run { return run }, "   ", reviewcore.CodeInvalidArgument},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			store := newTestStore(t, Options{})
			_, _, err := store.CreateRun(context.Background(), tc.mutate(newTestRun(t)), tc.key, "hash")
			requireCode(t, err, tc.code)
		})
	}
}

func TestCreateRunIndexCorrupt(t *testing.T) {
	store := newTestStore(t, Options{})
	if err := os.WriteFile(store.requestsPath, []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, _, err := store.CreateRun(context.Background(), newTestRun(t), "key", "hash")
	requireCode(t, err, reviewcore.CodeStateCorrupt)
	if !strings.Contains(err.Error(), "unexpected end of JSON input") {
		t.Fatalf("original JSON error was dropped: %v", err)
	}
}

func TestCreateRunIndexVersionUnsupported(t *testing.T) {
	store := newTestStore(t, Options{})
	data, err := json.Marshal(requestIndex{SchemaVersion: "peri-code-review/requests/v9", Entries: map[string]requestIndexEntry{}})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(store.requestsPath, data, 0o600); err != nil {
		t.Fatal(err)
	}
	_, _, createErr := store.CreateRun(context.Background(), newTestRun(t), "key", "hash")
	requireCode(t, createErr, reviewcore.CodeStateVersionUnsupported)
}

func TestCreateRunRollsBackIndex(t *testing.T) {
	store := newTestStore(t, Options{})
	first := newTestRun(t)
	if _, _, err := store.CreateRun(context.Background(), first, "key-a", "hash-a"); err != nil {
		t.Fatal(err)
	}
	original, err := os.ReadFile(store.requestsPath)
	if err != nil {
		t.Fatal(err)
	}

	failures := 1
	store.writeFile = func(path string, data []byte) error {
		if path == store.requestsPath && failures > 0 {
			failures--
			return errors.New("simulated write failure")
		}
		return writeFileAtomic(path, data)
	}

	second := newTestRun(t)
	_, isNew, createErr := store.CreateRun(context.Background(), second, "key-b", "hash-b")
	if isNew {
		t.Fatal("failed CreateRun reported a new run")
	}
	requireCode(t, createErr, reviewcore.CodeInternal)

	restored, err := os.ReadFile(store.requestsPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(restored, original) {
		t.Fatal("index was not restored")
	}
	if _, err := os.Stat(store.statePath(second.ReviewID)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("orphan state file kept: %v", err)
	}
	if _, err := store.LoadRun(context.Background(), first.ReviewID); err != nil {
		t.Fatalf("existing run damaged: %v", err)
	}
}

func TestCreateRunRollsBackFirstIndexWrite(t *testing.T) {
	store := newTestStore(t, Options{})
	store.writeFile = func(path string, data []byte) error {
		if path == store.requestsPath {
			return errors.New("simulated write failure")
		}
		return writeFileAtomic(path, data)
	}
	run := newTestRun(t)
	_, _, err := store.CreateRun(context.Background(), run, "key", "hash")
	requireCode(t, err, reviewcore.CodeInternal)
	if _, statErr := os.Stat(store.requestsPath); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("index file survived rollback: %v", statErr)
	}
	if _, statErr := os.Stat(store.statePath(run.ReviewID)); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("state file survived rollback: %v", statErr)
	}
}

func TestCreateRunReplayPropagatesCorruptRun(t *testing.T) {
	store := newTestStore(t, Options{})
	run := newTestRun(t)
	if _, _, err := store.CreateRun(context.Background(), run, "key", "hash"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(store.statePath(run.ReviewID), []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, _, err := store.CreateRun(context.Background(), newTestRun(t), "key", "hash")
	requireCode(t, err, reviewcore.CodeStateCorrupt)
}

func TestCreateRunStateInspectionFails(t *testing.T) {
	store := newTestStore(t, Options{})
	run := newTestRun(t)
	// A regular file where the run directory belongs makes Stat fail with
	// ENOTDIR instead of "not exist".
	if err := os.WriteFile(filepath.Join(store.runsDir, run.ReviewID), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, _, err := store.CreateRun(context.Background(), run, "key", "hash")
	requireCode(t, err, reviewcore.CodeInternal)
}

func TestCreateRunIndexReadFailure(t *testing.T) {
	store := newTestStore(t, Options{})
	if err := os.Mkdir(store.requestsPath, 0o700); err != nil {
		t.Fatal(err)
	}
	_, _, err := store.CreateRun(context.Background(), newTestRun(t), "key", "hash")
	requireCode(t, err, reviewcore.CodeInternal)
}

func TestCreateRunIndexWithoutEntries(t *testing.T) {
	store := newTestStore(t, Options{})
	empty := fmt.Sprintf(`{"schema_version":%q}`, requestsSchemaVersion)
	if err := os.WriteFile(store.requestsPath, []byte(empty), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, isNew, err := store.CreateRun(context.Background(), newTestRun(t), "key", "hash"); err != nil || !isNew {
		t.Fatalf("CreateRun = (%v, %v)", isNew, err)
	}
	data, err := os.ReadFile(store.requestsPath)
	if err != nil {
		t.Fatal(err)
	}
	var index requestIndex
	if err := json.Unmarshal(data, &index); err != nil {
		t.Fatal(err)
	}
	if len(index.Entries) != 1 {
		t.Fatalf("entries = %d, want 1", len(index.Entries))
	}
}

func TestCreateRunKeepsStateWhenRollbackFails(t *testing.T) {
	store := newTestStore(t, Options{})
	if _, _, err := store.CreateRun(context.Background(), newTestRun(t), "key-a", "hash-a"); err != nil {
		t.Fatal(err)
	}
	store.writeFile = func(path string, data []byte) error {
		if path == store.requestsPath {
			return errors.New("simulated write failure")
		}
		return writeFileAtomic(path, data)
	}
	second := newTestRun(t)
	_, _, err := store.CreateRun(context.Background(), second, "key-b", "hash-b")
	requireCode(t, err, reviewcore.CodeInternal)
	// The old index could not be restored, so the state file is kept rather
	// than leaving the index pointing at a missing run.
	if _, statErr := os.Stat(store.statePath(second.ReviewID)); statErr != nil {
		t.Fatalf("state file should be kept: %v", statErr)
	}
}

func TestLoadRunNotFound(t *testing.T) {
	store := newTestStore(t, Options{})
	_, err := store.LoadRun(context.Background(), "rv_"+strings.Repeat("a", 16))
	requireCode(t, err, reviewcore.CodeRunNotFound)
}

func TestLoadRunCorruptState(t *testing.T) {
	store := newTestStore(t, Options{})
	run := newTestRun(t)
	statePath := store.statePath(run.ReviewID)
	if err := os.MkdirAll(filepath.Dir(statePath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(statePath, []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := store.LoadRun(context.Background(), run.ReviewID)
	requireCode(t, err, reviewcore.CodeStateCorrupt)
	if !strings.Contains(err.Error(), "unexpected end of JSON input") {
		t.Fatalf("original JSON error was dropped: %v", err)
	}
}

func TestLoadRunReadFailure(t *testing.T) {
	store := newTestStore(t, Options{})
	run := newTestRun(t)
	statePath := store.statePath(run.ReviewID)
	if err := os.MkdirAll(filepath.Dir(statePath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(statePath, 0o700); err != nil {
		t.Fatal(err)
	}
	_, err := store.LoadRun(context.Background(), run.ReviewID)
	requireCode(t, err, reviewcore.CodeInternal)
}

func TestLoadRunVersionUnsupported(t *testing.T) {
	store := newTestStore(t, Options{})
	run := newTestRun(t)
	run.SchemaVersion = "peri-code-review/v99"
	writeRunFile(t, store.statePath(run.ReviewID), run)
	_, err := store.LoadRun(context.Background(), run.ReviewID)
	requireCode(t, err, reviewcore.CodeStateVersionUnsupported)
}

func TestLoadRunReviewIDMismatch(t *testing.T) {
	store := newTestStore(t, Options{})
	run := newTestRun(t)
	other := newTestRun(t)
	writeRunFile(t, store.statePath(run.ReviewID), other)
	_, err := store.LoadRun(context.Background(), run.ReviewID)
	requireCode(t, err, reviewcore.CodeStateCorrupt)
}

func TestLoadRunRejectsPathTraversal(t *testing.T) {
	store := newTestStore(t, Options{})
	ids := []string{
		"",
		"../state",
		"runs/../../../etc/passwd",
		"rv_",
		"rv_" + strings.Repeat("a", 15),
		"rv_" + strings.Repeat("a", 65),
		"rv_" + strings.Repeat("a", 16) + "/../../etc",
		"rv_" + strings.Repeat("A", 16),
		"rv_" + strings.Repeat("g", 16),
	}
	for _, id := range ids {
		_, err := store.LoadRun(context.Background(), id)
		requireCode(t, err, reviewcore.CodeInvalidArgument)
	}
}

func TestLoadRunHonoursCanceledContext(t *testing.T) {
	store := newTestStore(t, Options{})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := store.LoadRun(ctx, "rv_"+strings.Repeat("a", 16))
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("LoadRun error = %v, want context.Canceled", err)
	}
}

func writeRunFile(t *testing.T, path string, run *reviewcore.Run) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(run)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestUpdateRunSuccess(t *testing.T) {
	clockNow := time.Date(2026, 5, 2, 8, 0, 0, 0, time.UTC)
	store := newTestStore(t, Options{Clock: func() time.Time { return clockNow }})
	run := newTestRun(t)
	if _, _, err := store.CreateRun(context.Background(), run, "key", "hash"); err != nil {
		t.Fatal(err)
	}
	clockNow = clockNow.Add(time.Hour)

	updated, err := store.UpdateRun(context.Background(), run.ReviewID, func(current *reviewcore.Run) error {
		current.Status = reviewcore.RunCompleted
		return nil
	})
	if err != nil {
		t.Fatalf("UpdateRun: %v", err)
	}
	if updated.Status != reviewcore.RunCompleted {
		t.Fatalf("status = %q", updated.Status)
	}
	if updated.Version != 2 {
		t.Fatalf("version = %d, want 2", updated.Version)
	}
	if !updated.UpdatedAt.Equal(clockNow) {
		t.Fatalf("updated_at = %s, want %s", updated.UpdatedAt, clockNow)
	}

	loaded, err := store.LoadRun(context.Background(), run.ReviewID)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Status != updated.Status || loaded.Version != updated.Version || !loaded.UpdatedAt.Equal(updated.UpdatedAt) {
		t.Fatalf("persisted run = %+v, want %+v", loaded, updated)
	}
	assertNoTempFiles(t, store.dir)
}

func TestUpdateRunKeepsCallerUpdatedAt(t *testing.T) {
	clockNow := time.Date(2026, 5, 2, 8, 0, 0, 0, time.UTC)
	store := newTestStore(t, Options{Clock: func() time.Time { return clockNow }})
	run := newTestRun(t)
	if _, _, err := store.CreateRun(context.Background(), run, "key", "hash"); err != nil {
		t.Fatal(err)
	}
	custom := time.Date(2026, 5, 3, 9, 0, 0, 0, time.UTC)
	updated, err := store.UpdateRun(context.Background(), run.ReviewID, func(current *reviewcore.Run) error {
		current.UpdatedAt = custom
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if !updated.UpdatedAt.Equal(custom) {
		t.Fatalf("updated_at = %s, want caller value %s", updated.UpdatedAt, custom)
	}
}

func TestUpdateRunDefaultsZeroUpdatedAt(t *testing.T) {
	clockNow := time.Date(2026, 5, 2, 8, 0, 0, 0, time.UTC)
	store := newTestStore(t, Options{Clock: func() time.Time { return clockNow }})
	run := newTestRun(t)
	if _, _, err := store.CreateRun(context.Background(), run, "key", "hash"); err != nil {
		t.Fatal(err)
	}
	updated, err := store.UpdateRun(context.Background(), run.ReviewID, func(current *reviewcore.Run) error {
		current.UpdatedAt = time.Time{}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if !updated.UpdatedAt.Equal(clockNow) {
		t.Fatalf("updated_at = %s, want %s", updated.UpdatedAt, clockNow)
	}
}

func TestUpdateRunRollsBackOnError(t *testing.T) {
	store := newTestStore(t, Options{})
	run := newTestRun(t)
	if _, _, err := store.CreateRun(context.Background(), run, "key", "hash"); err != nil {
		t.Fatal(err)
	}

	_, err := store.UpdateRun(context.Background(), run.ReviewID, func(current *reviewcore.Run) error {
		current.Status = reviewcore.RunCompleted
		current.Background = "mutated"
		return reviewcore.Errorf(reviewcore.CodeRevisionConflict, "stale revision")
	})
	requireCode(t, err, reviewcore.CodeRevisionConflict)

	loaded, err := store.LoadRun(context.Background(), run.ReviewID)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Status != reviewcore.RunActive || loaded.Background != "" || loaded.Version != 1 {
		t.Fatalf("failed update leaked into state: %+v", loaded)
	}
}

func TestUpdateRunReplayDoesNotWrite(t *testing.T) {
	store := newTestStore(t, Options{})
	run := newTestRun(t)
	if _, _, err := store.CreateRun(context.Background(), run, "key", "hash"); err != nil {
		t.Fatal(err)
	}

	replayed, err := store.UpdateRun(context.Background(), run.ReviewID, func(current *reviewcore.Run) error {
		current.Background = "mutated"
		return reviewcore.ErrReplay
	})
	if err != nil {
		t.Fatalf("UpdateRun replay: %v", err)
	}
	if replayed.Background != "mutated" {
		t.Fatalf("replay did not return the in-memory run: %+v", replayed)
	}
	if replayed.Version != run.Version {
		t.Fatalf("replay version = %d, want %d", replayed.Version, run.Version)
	}

	loaded, err := store.LoadRun(context.Background(), run.ReviewID)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Background != "" || loaded.Version != 1 {
		t.Fatalf("replay wrote state: %+v", loaded)
	}
}

func TestUpdateRunNotFound(t *testing.T) {
	store := newTestStore(t, Options{})
	_, err := store.UpdateRun(context.Background(), "rv_"+strings.Repeat("b", 16), func(*reviewcore.Run) error {
		return nil
	})
	requireCode(t, err, reviewcore.CodeRunNotFound)
}

func TestUpdateRunValidatesReviewID(t *testing.T) {
	store := newTestStore(t, Options{})
	_, err := store.UpdateRun(context.Background(), "../escape", func(*reviewcore.Run) error {
		return nil
	})
	requireCode(t, err, reviewcore.CodeInvalidArgument)
}

func TestUpdateRunWriteFailure(t *testing.T) {
	store := newTestStore(t, Options{})
	run := newTestRun(t)
	if _, _, err := store.CreateRun(context.Background(), run, "key", "hash"); err != nil {
		t.Fatal(err)
	}
	store.writeFile = func(string, []byte) error {
		return errors.New("simulated write failure")
	}
	_, err := store.UpdateRun(context.Background(), run.ReviewID, func(current *reviewcore.Run) error {
		current.Status = reviewcore.RunCompleted
		return nil
	})
	requireCode(t, err, reviewcore.CodeInternal)

	loaded, err := store.LoadRun(context.Background(), run.ReviewID)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Status != reviewcore.RunActive || loaded.Version != 1 {
		t.Fatalf("failed write leaked into state: %+v", loaded)
	}
}

func TestUpdateRunRejectsNilCallback(t *testing.T) {
	store := newTestStore(t, Options{})
	run := newTestRun(t)
	if _, _, err := store.CreateRun(context.Background(), run, "key", "hash"); err != nil {
		t.Fatal(err)
	}
	_, err := store.UpdateRun(context.Background(), run.ReviewID, nil)
	requireCode(t, err, reviewcore.CodeInvalidArgument)
}

func TestUpdateRunConcurrentIncrement(t *testing.T) {
	store := newTestStore(t, Options{LockTimeout: 10 * time.Second})
	run := newTestRun(t)
	if _, _, err := store.CreateRun(context.Background(), run, "key", "hash"); err != nil {
		t.Fatal(err)
	}

	const workers = 16
	var group sync.WaitGroup
	failures := make(chan error, workers)
	for i := 0; i < workers; i++ {
		group.Add(1)
		go func(i int) {
			defer group.Done()
			_, err := store.UpdateRun(context.Background(), run.ReviewID, func(current *reviewcore.Run) error {
				current.Requests[fmt.Sprintf("key-%d", i)] = reviewcore.RequestRecord{Hash: "hash"}
				return nil
			})
			failures <- err
		}(i)
	}
	group.Wait()
	close(failures)
	for err := range failures {
		if err != nil {
			t.Fatalf("concurrent UpdateRun: %v", err)
		}
	}

	loaded, err := store.LoadRun(context.Background(), run.ReviewID)
	if err != nil {
		t.Fatal(err)
	}
	if len(loaded.Requests) != workers {
		t.Fatalf("requests = %d, want %d", len(loaded.Requests), workers)
	}
	if loaded.Version != int64(workers+1) {
		t.Fatalf("version = %d, want %d", loaded.Version, workers+1)
	}
	assertNoTempFiles(t, store.dir)
}
