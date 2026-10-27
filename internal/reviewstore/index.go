// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package reviewstore

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"

	"github.com/KonghaYao/open-code-review/internal/reviewcore"
)

// requestsSchemaVersion is independent of the run schema so the index can
// evolve without rewriting every stored run.
const requestsSchemaVersion = "peri-code-review/requests/v1"

type requestIndex struct {
	SchemaVersion string                       `json:"schema_version"`
	Entries       map[string]requestIndexEntry `json:"entries"`
}

// requestIndexEntry keeps the original key because the digest that indexes it
// is one-way.
type requestIndexEntry struct {
	Key      string `json:"request_key"`
	Hash     string `json:"request_hash"`
	ReviewID string `json:"review_id"`
}

// loadRequests returns the index plus the bytes it was parsed from, which
// CreateRun uses to restore the file when the following write fails.
func (s *Store) loadRequests() (*requestIndex, []byte, error) {
	data, err := os.ReadFile(s.requestsPath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return &requestIndex{
				SchemaVersion: requestsSchemaVersion,
				Entries:       map[string]requestIndexEntry{},
			}, nil, nil
		}
		return nil, nil, reviewcore.Errorf(reviewcore.CodeInternal, "read requests index: %v", err)
	}
	var index requestIndex
	if err := json.Unmarshal(data, &index); err != nil {
		return nil, nil, fmt.Errorf("%w: decode requests index: %w", reviewcore.Errorf(reviewcore.CodeStateCorrupt, "requests index is not valid JSON"), err)
	}
	if index.SchemaVersion != requestsSchemaVersion {
		return nil, nil, reviewcore.Errorf(reviewcore.CodeStateVersionUnsupported, "requests index uses unsupported schema_version %q", index.SchemaVersion)
	}
	if index.Entries == nil {
		index.Entries = map[string]requestIndexEntry{}
	}
	return &index, data, nil
}

func (s *Store) restoreRequests(previous []byte) error {
	if previous == nil {
		if err := os.Remove(s.requestsPath); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		return nil
	}
	return s.writeFile(s.requestsPath, previous)
}
