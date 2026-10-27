// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package reviewcore

import (
	"encoding/base64"
	"encoding/json"
	"strings"
)

type pageCursor struct {
	ReviewID   string `json:"r"`
	SnapshotID string `json:"s"`
	Query      string `json:"q"`
	Offset     int    `json:"o"`
	Line       int    `json:"l,omitempty"`
}

// QueryHash binds a cursor to the exact query it was produced for.
func QueryHash(parts ...string) string { return HashString(strings.Join(parts, "\x00")) }

// EncodeCursor returns an opaque cursor bound to review, snapshot and query.
func EncodeCursor(reviewID, snapshotID, query string, offset, line int) string {
	data, _ := json.Marshal(pageCursor{
		ReviewID: reviewID, SnapshotID: snapshotID, Query: query, Offset: offset, Line: line,
	})
	return base64.RawURLEncoding.EncodeToString(data)
}

// DecodeCursor validates the binding and returns the offset and line state.
func DecodeCursor(cursor, reviewID, snapshotID, query string) (offset, line int, err error) {
	if cursor == "" {
		return 0, 0, nil
	}
	data, decodeErr := base64.RawURLEncoding.DecodeString(cursor)
	if decodeErr != nil {
		return 0, 0, Errorf(CodeInvalidCursor, "cursor is not valid base64")
	}
	var parsed pageCursor
	if jsonErr := json.Unmarshal(data, &parsed); jsonErr != nil {
		return 0, 0, Errorf(CodeInvalidCursor, "cursor is not valid JSON")
	}
	if parsed.ReviewID != reviewID || parsed.SnapshotID != snapshotID || parsed.Query != query ||
		parsed.Offset < 0 || parsed.Line < 0 {
		return 0, 0, Errorf(CodeInvalidCursor, "cursor does not belong to this review and query")
	}
	return parsed.Offset, parsed.Line, nil
}

// ClampLimit applies the caller limit and returns the effective page size.
func ClampLimit(limit, defaultValue, maxValue int) int {
	if limit <= 0 {
		return defaultValue
	}
	if limit > maxValue {
		return maxValue
	}
	return limit
}

func pageBounds(total, offset, limit int) (int, int) {
	if offset < 0 {
		offset = 0
	}
	if offset > total {
		offset = total
	}
	end := offset + limit
	if end > total {
		end = total
	}
	return offset, end
}
