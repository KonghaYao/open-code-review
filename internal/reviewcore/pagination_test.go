// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package reviewcore

import (
	"fmt"
	"testing"
)

func TestPrepareCursorIsConsumedByStatusUnits(t *testing.T) {
	run := &Run{
		ReviewID: "rv_0123456789abcdef",
		Snapshot: &Snapshot{ID: "snap_test"},
		Units:    make([]Unit, 25),
	}
	for i := range run.Units {
		run.Units[i] = Unit{ID: fmt.Sprintf("u%02d", i), Kind: UnitFile, Status: UnitPending}
	}
	page, cursor := pageUnits(run.Units, 0, 20, run)
	if len(page) != 20 {
		t.Fatalf("first page has %d units, want 20", len(page))
	}
	if cursor == "" {
		t.Fatal("first page must return a cursor")
	}
	offset, _, err := DecodeCursor(cursor, run.ReviewID, run.Snapshot.ID, QueryHash("status", "units"))
	if err != nil {
		t.Fatalf("prepare cursor must be accepted by status units: %v", err)
	}
	if offset != 20 {
		t.Fatalf("cursor offset = %d, want 20", offset)
	}
}
