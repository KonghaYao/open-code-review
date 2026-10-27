// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package reviewstore

import (
	"context"
	"errors"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/KonghaYao/open-code-review/internal/reviewcore"
)

func TestLockWaitHonoursCanceledContext(t *testing.T) {
	lock := fileLock{path: filepath.Join(t.TempDir(), "test.lock"), timeout: time.Hour}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := lock.wait(ctx, time.Now().Add(time.Hour)); !errors.Is(err, context.Canceled) {
		t.Fatalf("wait error = %v, want context.Canceled", err)
	}
}

func TestLockWaitStopsWhenContextEnds(t *testing.T) {
	lock := fileLock{path: filepath.Join(t.TempDir(), "test.lock"), timeout: time.Hour}
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(2 * time.Millisecond)
		cancel()
	}()
	if err := lock.wait(ctx, time.Now().Add(time.Hour)); !errors.Is(err, context.Canceled) {
		t.Fatalf("wait error = %v, want context.Canceled", err)
	}
}

func TestUpdateRunLockTimeout(t *testing.T) {
	store := newTestStore(t, Options{LockTimeout: 40 * time.Millisecond})
	run := newTestRun(t)
	if _, _, err := store.CreateRun(context.Background(), run, "key", "hash"); err != nil {
		t.Fatal(err)
	}

	started := make(chan struct{})
	release := make(chan struct{})
	holderErr := make(chan error, 1)
	var group sync.WaitGroup
	group.Add(1)
	go func() {
		defer group.Done()
		_, err := store.UpdateRun(context.Background(), run.ReviewID, func(*reviewcore.Run) error {
			close(started)
			<-release
			return nil
		})
		holderErr <- err
	}()
	<-started

	callbackRan := false
	_, err := store.UpdateRun(context.Background(), run.ReviewID, func(*reviewcore.Run) error {
		callbackRan = true
		return nil
	})
	requireCode(t, err, reviewcore.CodeExecutionTimeout)
	if callbackRan {
		t.Fatal("callback ran without the lock")
	}

	close(release)
	group.Wait()
	if err := <-holderErr; err != nil {
		t.Fatalf("lock holder: %v", err)
	}
}

func TestCreateRunLockTimeout(t *testing.T) {
	store := newTestStore(t, Options{LockTimeout: 40 * time.Millisecond})
	release, err := store.lock(context.Background(), requestsLockName)
	if err != nil {
		t.Fatalf("hold requests lock: %v", err)
	}

	_, _, createErr := store.CreateRun(context.Background(), newTestRun(t), "key", "hash")
	requireCode(t, createErr, reviewcore.CodeExecutionTimeout)

	release()
	if _, _, err := store.CreateRun(context.Background(), newTestRun(t), "key", "hash"); err != nil {
		t.Fatalf("CreateRun after release: %v", err)
	}
}

func TestUpdateRunLockHonoursCancellation(t *testing.T) {
	store := newTestStore(t, Options{LockTimeout: 10 * time.Second})
	run := newTestRun(t)
	if _, _, err := store.CreateRun(context.Background(), run, "key", "hash"); err != nil {
		t.Fatal(err)
	}

	started := make(chan struct{})
	release := make(chan struct{})
	var group sync.WaitGroup
	group.Add(1)
	go func() {
		defer group.Done()
		_, _ = store.UpdateRun(context.Background(), run.ReviewID, func(*reviewcore.Run) error {
			close(started)
			<-release
			return nil
		})
	}()
	<-started

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	_, err := store.UpdateRun(ctx, run.ReviewID, func(*reviewcore.Run) error {
		return nil
	})
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("UpdateRun error = %v, want context.DeadlineExceeded", err)
	}

	close(release)
	group.Wait()
}

func TestCreateRunHonoursCanceledContext(t *testing.T) {
	store := newTestStore(t, Options{})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, _, err := store.CreateRun(ctx, newTestRun(t), "key", "hash")
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("CreateRun error = %v, want context.Canceled", err)
	}
}
