// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package reviewstore

import (
	"os"
	"path/filepath"
	"runtime"
)

const tempFilePattern = ".tmp-*"

// writeFileAtomic replaces path with data. The temp file lives in the target
// directory so the rename stays on one filesystem and is atomic for readers.
func writeFileAtomic(path string, data []byte) (err error) {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	file, err := os.CreateTemp(dir, tempFilePattern)
	if err != nil {
		return err
	}
	tempPath := file.Name()
	replaced := false
	defer func() {
		if !replaced {
			_ = file.Close()
			_ = os.Remove(tempPath)
		}
	}()

	if err := file.Chmod(0o600); err != nil {
		return err
	}
	if _, err := file.Write(data); err != nil {
		return err
	}
	if err := file.Sync(); err != nil {
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	if err := os.Rename(tempPath, path); err != nil {
		return err
	}
	replaced = true
	if runtime.GOOS == "windows" {
		// Windows cannot fsync a directory handle opened this way.
		return nil
	}
	return syncDir(dir)
}

func syncDir(dir string) error {
	handle, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer handle.Close()
	return handle.Sync()
}
