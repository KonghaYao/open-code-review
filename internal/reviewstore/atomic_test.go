// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package reviewstore

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWriteFileAtomicReplacesContent(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "runs", "rv_0123456789abcdef", "state.json")
	if err := writeFileAtomic(path, []byte("first")); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := writeFileAtomic(path, []byte("second")); err != nil {
		t.Fatalf("rewrite: %v", err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "second" {
		t.Fatalf("content = %q", data)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("mode = %o, want 600", perm)
	}
	dirInfo, err := os.Stat(filepath.Dir(path))
	if err != nil {
		t.Fatal(err)
	}
	if perm := dirInfo.Mode().Perm(); perm != 0o700 {
		t.Fatalf("parent mode = %o, want 700", perm)
	}
	assertNoTempFiles(t, dir)
}

func TestWriteFileAtomicCleansTempOnFailure(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "state.json")
	// Renaming a file over a non-empty directory must fail after the temp
	// file has already been written.
	if err := os.Mkdir(target, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(target, "keep"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := writeFileAtomic(target, []byte("data")); err == nil {
		t.Fatal("writeFileAtomic succeeded over a directory")
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".tmp-") {
			t.Fatalf("temporary file left behind: %s", entry.Name())
		}
	}
}

func TestSyncDirRejectsMissingDirectory(t *testing.T) {
	if err := syncDir(filepath.Join(t.TempDir(), "missing")); err == nil {
		t.Fatal("syncDir accepted a missing directory")
	}
}
