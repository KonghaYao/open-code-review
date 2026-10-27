// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

//go:build windows

package reviewstore

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"time"

	"github.com/KonghaYao/open-code-review/internal/reviewcore"
)

// A crashed process leaves its lock file behind, so an old file is treated as
// abandoned. The threshold is generous compared with real update durations.
const staleLockAge = 5 * time.Minute

// acquire uses an exclusively created file as the lock, because Windows has no
// flock equivalent on a plain file.
func (l fileLock) acquire(ctx context.Context) (func(), error) {
	deadline := time.Now().Add(l.timeout)
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		release, acquired, err := l.create()
		if err != nil {
			return nil, err
		}
		if acquired {
			return release, nil
		}
		l.removeStale()
		if err := l.wait(ctx, deadline); err != nil {
			return nil, err
		}
	}
}

func (l fileLock) create() (func(), bool, error) {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return nil, false, reviewcore.Errorf(reviewcore.CodeInternal, "generate lock token: %v", err)
	}
	token := hex.EncodeToString(raw)
	file, err := os.OpenFile(l.path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		if errors.Is(err, fs.ErrExist) {
			return nil, false, nil
		}
		return nil, false, reviewcore.Errorf(reviewcore.CodeInternal, "open lock %s: %v", filepath.Base(l.path), err)
	}
	if _, err := file.WriteString(token); err != nil {
		_ = file.Close()
		_ = os.Remove(l.path)
		return nil, false, reviewcore.Errorf(reviewcore.CodeInternal, "write lock %s: %v", filepath.Base(l.path), err)
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(l.path)
		return nil, false, reviewcore.Errorf(reviewcore.CodeInternal, "close lock %s: %v", filepath.Base(l.path), err)
	}
	return func() {
		// The token guards against deleting a lock that was reclaimed as stale
		// and then taken by another process.
		if data, err := os.ReadFile(l.path); err == nil && string(data) == token {
			_ = os.Remove(l.path)
		}
	}, true, nil
}

func (l fileLock) removeStale() {
	info, err := os.Stat(l.path)
	if err != nil || time.Since(info.ModTime()) < staleLockAge {
		return
	}
	_ = os.Remove(l.path)
}
