// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package reviewcore

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
)

// NewID returns a random identifier with the given prefix.
func NewID(prefix string) (string, error) {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return "", fmt.Errorf("generate id: %w", err)
	}
	return prefix + hex.EncodeToString(buf[:]), nil
}

// HashBytes returns a stable sha256 digest string.
func HashBytes(data []byte) string {
	sum := sha256.Sum256(data)
	return "sha256:" + hex.EncodeToString(sum[:])
}

// HashString returns a stable sha256 digest string.
func HashString(value string) string { return HashBytes([]byte(value)) }

// CanonicalHash hashes the canonical JSON encoding of value. encoding/json
// sorts map keys, so the result is deterministic across processes.
func CanonicalHash(value any) (string, error) {
	data, err := json.Marshal(value)
	if err != nil {
		return "", Errorf(CodeInternal, "encode canonical request: %v", err)
	}
	return HashBytes(data), nil
}

func shortHash(parts ...string) string {
	h := sha256.New()
	for _, part := range parts {
		_, _ = h.Write([]byte(part))
		_, _ = h.Write([]byte{0})
	}
	return hex.EncodeToString(h.Sum(nil))[:16]
}
