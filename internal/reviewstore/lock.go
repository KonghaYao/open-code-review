// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package reviewstore

import (
	"context"
	"path/filepath"
	"time"

	"github.com/KonghaYao/open-code-review/internal/reviewcore"
)

// lockPollInterval keeps retry cost negligible while still reacting quickly.
const lockPollInterval = 5 * time.Millisecond

type fileLock struct {
	path    string
	timeout time.Duration
}

func (l fileLock) timeoutError() error {
	return reviewcore.Errorf(reviewcore.CodeExecutionTimeout, "timed out after %s waiting for lock %s", l.timeout, filepath.Base(l.path))
}

// wait blocks for one poll interval and honours caller cancellation.
func (l fileLock) wait(ctx context.Context, deadline time.Time) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	remaining := time.Until(deadline)
	if remaining <= 0 {
		return l.timeoutError()
	}
	delay := lockPollInterval
	if remaining < delay {
		delay = remaining
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
