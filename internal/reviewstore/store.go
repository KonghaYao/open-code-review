// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

// Package reviewstore persists review runs as atomically replaced JSON files
// and serializes mutations with cross-process file locks.
package reviewstore

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/KonghaYao/open-code-review/internal/reviewcore"
)

const (
	defaultLockTimeout = 10 * time.Second

	runsDirName      = "runs"
	locksDirName     = "locks"
	runStateFileName = "state.json"
	requestsFileName = "requests.json"

	requestsLockName = "requests.lock"
	runLockPrefix    = "run-"
	runLockSuffix    = ".lock"
)

var reviewIDPattern = regexp.MustCompile(`^rv_[0-9a-f]{16,64}$`)

// Options tunes a Store. Zero values fall back to production defaults.
type Options struct {
	// LockTimeout bounds how long a mutation waits for a competing process.
	LockTimeout time.Duration
	// Clock supplies UpdatedAt when an update leaves it untouched.
	Clock func() time.Time
}

// Store implements reviewcore.Store with a directory of JSON documents.
type Store struct {
	dir          string
	runsDir      string
	locksDir     string
	requestsPath string
	lockTimeout  time.Duration
	clock        func() time.Time

	// writeFile is a seam for tests that need to fail one write; production
	// always uses writeFileAtomic.
	writeFile func(path string, data []byte) error
}

var _ reviewcore.Store = (*Store)(nil)

// New creates the state root when it is missing. Directories are private
// because run state contains repository content.
func New(dir string, opts Options) (*Store, error) {
	if strings.TrimSpace(dir) == "" {
		return nil, reviewcore.Errorf(reviewcore.CodeInvalidArgument, "state directory is required")
	}
	dir = filepath.Clean(dir)
	runsDir := filepath.Join(dir, runsDirName)
	locksDir := filepath.Join(dir, locksDirName)
	for _, path := range []string{dir, runsDir, locksDir} {
		if err := os.MkdirAll(path, 0o700); err != nil {
			return nil, reviewcore.Errorf(reviewcore.CodeInternal, "create state directory: %v", err)
		}
	}
	lockTimeout := opts.LockTimeout
	if lockTimeout <= 0 {
		lockTimeout = defaultLockTimeout
	}
	clock := opts.Clock
	if clock == nil {
		clock = time.Now
	}
	return &Store{
		dir:          dir,
		runsDir:      runsDir,
		locksDir:     locksDir,
		requestsPath: filepath.Join(dir, requestsFileName),
		lockTimeout:  lockTimeout,
		clock:        clock,
		writeFile:    writeFileAtomic,
	}, nil
}

// CreateRun stores a new run and binds it to requestKey. A repeated key with
// the same hash returns the stored run; a different hash is a conflict.
func (s *Store) CreateRun(ctx context.Context, run *reviewcore.Run, requestKey, requestHash string) (*reviewcore.Run, bool, error) {
	if run == nil {
		return nil, false, reviewcore.Errorf(reviewcore.CodeInvalidArgument, "run is required")
	}
	if err := validateNewRun(run); err != nil {
		return nil, false, err
	}
	if strings.TrimSpace(requestKey) == "" {
		return nil, false, reviewcore.Errorf(reviewcore.CodeInvalidArgument, "request_key is required")
	}

	release, err := s.lock(ctx, requestsLockName)
	if err != nil {
		return nil, false, err
	}
	defer release()

	index, previous, err := s.loadRequests()
	if err != nil {
		return nil, false, err
	}
	digest := requestKeyDigest(requestKey)
	if entry, ok := index.Entries[digest]; ok {
		if entry.Hash != requestHash {
			return nil, false, reviewcore.Errorf(reviewcore.CodeIdempotencyConflict, "request_key was already used with a different request")
		}
		existing, loadErr := s.loadRun(ctx, entry.ReviewID)
		if loadErr != nil {
			if reviewcore.IsCode(loadErr, reviewcore.CodeRunNotFound) {
				return nil, false, reviewcore.Errorf(reviewcore.CodeStateCorrupt, "requests index references missing run %s", entry.ReviewID)
			}
			return nil, false, loadErr
		}
		return existing, false, nil
	}

	statePath := s.statePath(run.ReviewID)
	if _, statErr := os.Stat(statePath); statErr == nil {
		return nil, false, reviewcore.Errorf(reviewcore.CodeStateCorrupt, "run %s exists without a requests index entry", run.ReviewID)
	} else if !errors.Is(statErr, os.ErrNotExist) {
		return nil, false, reviewcore.Errorf(reviewcore.CodeInternal, "inspect run state: %v", statErr)
	}

	data, err := json.Marshal(run)
	if err != nil {
		return nil, false, reviewcore.Errorf(reviewcore.CodeInternal, "encode run state: %v", err)
	}
	if err := s.writeFile(statePath, data); err != nil {
		return nil, false, reviewcore.Errorf(reviewcore.CodeInternal, "write run state: %v", err)
	}

	index.Entries[digest] = requestIndexEntry{Key: requestKey, Hash: requestHash, ReviewID: run.ReviewID}
	indexData, err := json.Marshal(index)
	if err != nil {
		s.discardRunState(run.ReviewID)
		return nil, false, reviewcore.Errorf(reviewcore.CodeInternal, "encode requests index: %v", err)
	}
	if err := s.writeFile(s.requestsPath, indexData); err != nil {
		// Only remove the state file once the index no longer references it;
		// a leftover state file is recoverable, a dangling entry is not.
		if rollbackErr := s.restoreRequests(previous); rollbackErr == nil {
			s.discardRunState(run.ReviewID)
		}
		return nil, false, reviewcore.Errorf(reviewcore.CodeInternal, "write requests index: %v", err)
	}
	return run, true, nil
}

// LoadRun reads one run by identifier. It never follows a caller-supplied
// path, so the identifier is validated before it reaches the filesystem.
func (s *Store) LoadRun(ctx context.Context, reviewID string) (*reviewcore.Run, error) {
	if err := validateReviewID(reviewID); err != nil {
		return nil, err
	}
	return s.loadRun(ctx, reviewID)
}

func (s *Store) loadRun(ctx context.Context, reviewID string) (*reviewcore.Run, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	data, err := os.ReadFile(s.statePath(reviewID))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, reviewcore.Errorf(reviewcore.CodeRunNotFound, "run %s does not exist", reviewID)
		}
		return nil, reviewcore.Errorf(reviewcore.CodeInternal, "read run state: %v", err)
	}
	var run reviewcore.Run
	if err := json.Unmarshal(data, &run); err != nil {
		// Keep the JSON error reachable so callers can log the real cause.
		return nil, fmt.Errorf("%w: decode run state: %w", reviewcore.Errorf(reviewcore.CodeStateCorrupt, "run %s state is not valid JSON", reviewID), err)
	}
	if run.SchemaVersion != reviewcore.SchemaVersion {
		return nil, reviewcore.Errorf(reviewcore.CodeStateVersionUnsupported, "run %s uses unsupported schema_version %q", reviewID, run.SchemaVersion)
	}
	if run.ReviewID != reviewID {
		return nil, reviewcore.Errorf(reviewcore.CodeStateCorrupt, "run %s state contains review_id %q", reviewID, run.ReviewID)
	}
	return &run, nil
}

// UpdateRun applies update under an exclusive per-run lock. The state file is
// replaced only when update reports success without ErrReplay.
func (s *Store) UpdateRun(ctx context.Context, reviewID string, update func(*reviewcore.Run) error) (*reviewcore.Run, error) {
	if err := validateReviewID(reviewID); err != nil {
		return nil, err
	}
	if update == nil {
		return nil, reviewcore.Errorf(reviewcore.CodeInvalidArgument, "update callback is required")
	}

	release, err := s.lock(ctx, runLockPrefix+reviewID+runLockSuffix)
	if err != nil {
		return nil, err
	}
	defer release()

	run, err := s.loadRun(ctx, reviewID)
	if err != nil {
		return nil, err
	}
	loadedUpdatedAt := run.UpdatedAt
	if err := update(run); err != nil {
		if errors.Is(err, reviewcore.ErrReplay) {
			return run, nil
		}
		return nil, err
	}

	run.Version++
	if run.UpdatedAt.IsZero() || run.UpdatedAt.Equal(loadedUpdatedAt) {
		run.UpdatedAt = s.clock().UTC()
	}
	data, err := json.Marshal(run)
	if err != nil {
		return nil, reviewcore.Errorf(reviewcore.CodeInternal, "encode run state: %v", err)
	}
	if err := s.writeFile(s.statePath(reviewID), data); err != nil {
		return nil, reviewcore.Errorf(reviewcore.CodeInternal, "write run state: %v", err)
	}
	return run, nil
}

func validateNewRun(run *reviewcore.Run) error {
	if err := validateReviewID(run.ReviewID); err != nil {
		return err
	}
	if run.SchemaVersion != reviewcore.SchemaVersion {
		return reviewcore.Errorf(reviewcore.CodeInvalidArgument, "unsupported run schema_version %q", run.SchemaVersion)
	}
	if run.Version < 1 {
		return reviewcore.Errorf(reviewcore.CodeInvalidArgument, "run version must be at least 1")
	}
	return nil
}

func validateReviewID(reviewID string) error {
	if !reviewIDPattern.MatchString(reviewID) {
		return reviewcore.Errorf(reviewcore.CodeInvalidArgument, "invalid review_id")
	}
	return nil
}

func requestKeyDigest(requestKey string) string {
	sum := sha256.Sum256([]byte(requestKey))
	return hex.EncodeToString(sum[:])
}

func (s *Store) statePath(reviewID string) string {
	return filepath.Join(s.runsDir, reviewID, runStateFileName)
}

func (s *Store) discardRunState(reviewID string) {
	statePath := s.statePath(reviewID)
	_ = os.Remove(statePath)
	_ = os.Remove(filepath.Dir(statePath))
}

func (s *Store) lock(ctx context.Context, name string) (func(), error) {
	lock := fileLock{path: filepath.Join(s.locksDir, name), timeout: s.lockTimeout}
	return lock.acquire(ctx)
}
