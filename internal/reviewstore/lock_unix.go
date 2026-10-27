// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

//go:build !windows

package reviewstore

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"syscall"
	"time"

	"github.com/KonghaYao/open-code-review/internal/reviewcore"
)

// acquire takes an exclusive flock. The descriptor stays open for the lifetime
// of the lock, because flock binds the lock to the open file description.
func (l fileLock) acquire(ctx context.Context) (func(), error) {
	file, err := os.OpenFile(l.path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, reviewcore.Errorf(reviewcore.CodeInternal, "open lock %s: %v", filepath.Base(l.path), err)
	}
	deadline := time.Now().Add(l.timeout)
	for {
		if err := ctx.Err(); err != nil {
			_ = file.Close()
			return nil, err
		}
		err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			return func() {
				_ = syscall.Flock(int(file.Fd()), syscall.LOCK_UN)
				_ = file.Close()
			}, nil
		}
		if !errors.Is(err, syscall.EWOULDBLOCK) && !errors.Is(err, syscall.EAGAIN) {
			_ = file.Close()
			return nil, reviewcore.Errorf(reviewcore.CodeInternal, "lock %s: %v", filepath.Base(l.path), err)
		}
		if err := l.wait(ctx, deadline); err != nil {
			_ = file.Close()
			return nil, err
		}
	}
}
