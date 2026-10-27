// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package reviewcore

import (
	"encoding/base64"
	"encoding/json"
	"testing"
)

func TestCursorRoundTrip(t *testing.T) {
	cursor := EncodeCursor("rv_0123456789abcdef", "snap_abc", "units", 40, 7)
	offset, line, err := DecodeCursor(cursor, "rv_0123456789abcdef", "snap_abc", "units")
	if err != nil {
		t.Fatalf("DecodeCursor: %v", err)
	}
	if offset != 40 || line != 7 {
		t.Fatalf("cursor = (%d, %d), want (40, 7)", offset, line)
	}

	offset, line, err = DecodeCursor("", "rv_0123456789abcdef", "snap_abc", "units")
	if err != nil || offset != 0 || line != 0 {
		t.Fatalf("empty cursor = (%d, %d, %v), want zero values", offset, line, err)
	}
}

func TestDecodeCursorRejectsForeignBindings(t *testing.T) {
	cursor := EncodeCursor("rv_0123456789abcdef", "snap_abc", "units", 40, 0)
	tests := []struct {
		name       string
		reviewID   string
		snapshotID string
		query      string
	}{
		{name: "other review", reviewID: "rv_fedcba9876543210", snapshotID: "snap_abc", query: "units"},
		{name: "other snapshot", reviewID: "rv_0123456789abcdef", snapshotID: "snap_other", query: "units"},
		{name: "other query", reviewID: "rv_0123456789abcdef", snapshotID: "snap_abc", query: "coverage"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, _, err := DecodeCursor(cursor, test.reviewID, test.snapshotID, test.query)
			if !IsCode(err, CodeInvalidCursor) {
				t.Fatalf("error = %v, want %s", err, CodeInvalidCursor)
			}
		})
	}
}

func TestDecodeCursorRejectsTamperedPayloads(t *testing.T) {
	foreign := EncodeCursor("rv_0123456789abcdef", "snap_abc", "units", 1, 0)

	negative, err := json.Marshal(pageCursor{
		ReviewID: "rv_0123456789abcdef", SnapshotID: "snap_abc", Query: "units", Offset: -1,
	})
	if err != nil {
		t.Fatal(err)
	}
	negativeLine, err := json.Marshal(pageCursor{
		ReviewID: "rv_0123456789abcdef", SnapshotID: "snap_abc", Query: "units", Line: -2,
	})
	if err != nil {
		t.Fatal(err)
	}

	tests := []struct {
		name   string
		cursor string
	}{
		{name: "invalid base64", cursor: "!!!not-base64!!!"},
		{name: "invalid json", cursor: base64.RawURLEncoding.EncodeToString([]byte("{"))},
		{name: "negative offset", cursor: base64.RawURLEncoding.EncodeToString(negative)},
		{name: "negative line", cursor: base64.RawURLEncoding.EncodeToString(negativeLine)},
		{name: "padded base64", cursor: base64.URLEncoding.EncodeToString([]byte("{}"))},
		{name: "foreign binding", cursor: foreign + "x"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, _, err := DecodeCursor(test.cursor, "rv_0123456789abcdef", "snap_abc", "units")
			if !IsCode(err, CodeInvalidCursor) {
				t.Fatalf("error = %v, want %s", err, CodeInvalidCursor)
			}
		})
	}
}
