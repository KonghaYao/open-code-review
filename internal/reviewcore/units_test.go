// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package reviewcore

import (
	"reflect"
	"testing"
)

func TestPlanUnitsIncludesFilesAndCrossFileUnit(t *testing.T) {
	changes := planTestChanges()
	units, excluded := PlanUnits(changes, Scope{IncludeTests: true, IncludeDeleted: true}, nil)

	wantIncluded := []string{"a.go", "a_test.go", "b.go", "deleted.go"}
	cross := findUnitByKind(t, units, UnitCrossFile)
	if !reflect.DeepEqual(cross.Paths, wantIncluded) {
		t.Fatalf("cross-file paths = %#v, want %#v", cross.Paths, wantIncluded)
	}
	wantChangeIDs := []string{"c_a", "c_b", "c_del", "c_test"}
	if !reflect.DeepEqual(cross.ChangeIDs, wantChangeIDs) {
		t.Fatalf("cross-file change IDs = %#v, want %#v", cross.ChangeIDs, wantChangeIDs)
	}

	for _, path := range wantIncluded {
		unit := findFileUnit(t, units, path)
		if unit.Status != UnitPending {
			t.Fatalf("unit for %s status = %q, want pending", path, unit.Status)
		}
	}
	if unit := findFileUnit(t, units, "b.go"); !unit.FullFile || unit.Side != SideNew {
		t.Fatalf("b.go unit = %+v, want a full new-side unit", unit)
	}
	if unit := findFileUnit(t, units, "deleted.go"); unit.Side != SideOld {
		t.Fatalf("deleted.go unit side = %q, want old", unit.Side)
	}

	provider := findExcluded(t, excluded, "vendor/lib.go")
	if provider.Reason != ExcludeProvider || provider.Side != SideNew {
		t.Fatalf("provider exclusion = %+v", provider)
	}
	if hasUnitPath(units, "vendor/lib.go") {
		t.Fatal("provider path must not appear in any unit")
	}
}

func TestPlanUnitsExcludesTestsWhenDisabled(t *testing.T) {
	units, excluded := PlanUnits(planTestChanges(), Scope{IncludeTests: false, IncludeDeleted: true}, nil)

	entry := findExcluded(t, excluded, "a_test.go")
	if entry.Reason != ExcludeTests {
		t.Fatalf("test exclusion = %+v, want %q", entry, ExcludeTests)
	}
	if hasUnitPath(units, "a_test.go") {
		t.Fatal("excluded test file must not appear in any unit")
	}
	cross := findUnitByKind(t, units, UnitCrossFile)
	if containsString(cross.Paths, "a_test.go") {
		t.Fatalf("cross-file paths = %#v, must not include the test file", cross.Paths)
	}
}

func TestPlanUnitsExcludesDeletedWhenDisabled(t *testing.T) {
	units, excluded := PlanUnits(planTestChanges(), Scope{IncludeTests: true, IncludeDeleted: false}, nil)

	entry := findExcluded(t, excluded, "deleted.go")
	if entry.Reason != ExcludeDeleted || entry.Side != SideOld {
		t.Fatalf("deleted exclusion = %+v, want %q on the old side", entry, ExcludeDeleted)
	}
	if hasUnitPath(units, "deleted.go") {
		t.Fatal("excluded deletion must not appear in any unit")
	}
	cross := findUnitByKind(t, units, UnitCrossFile)
	if containsString(cross.Paths, "deleted.go") {
		t.Fatalf("cross-file paths = %#v, must not include the deleted file", cross.Paths)
	}
}

func TestPlanUnitsSplitsOversizedHunks(t *testing.T) {
	const changedLines = 1000
	lines := make([]string, changedLines)
	for i := range lines {
		lines[i] = "+line"
	}
	change := Change{
		ID: "c_big", NewPath: "big.go", Source: "workspace",
		Hunks: []Hunk{{NewStart: 1, NewCount: changedLines, Header: "@@ -0,0 +1,1000 @@", Lines: lines}},
	}

	units, _ := PlanUnits([]Change{change}, Scope{IncludeTests: true, IncludeDeleted: true}, nil)
	var fileUnits []Unit
	for _, unit := range units {
		if unit.Kind == UnitFile && len(unit.ChangeIDs) == 1 && unit.ChangeIDs[0] == change.ID {
			fileUnits = append(fileUnits, unit)
		}
	}
	if len(fileUnits) < 2 {
		t.Fatalf("got %d units, want the hunk split across at least two", len(fileUnits))
	}

	total := 0
	for _, unit := range fileUnits {
		if len(unit.Slices) != 1 {
			t.Fatalf("unit %s slices = %+v, want one hunk slice", unit.ID, unit.Slices)
		}
		slice := unit.Slices[0]
		if slice.HunkIndex != 0 || slice.Start < 0 || slice.End > len(lines) || slice.Start >= slice.End {
			t.Fatalf("unit %s has an invalid slice: %+v", unit.ID, slice)
		}
		changed := 0
		for _, line := range lines[slice.Start:slice.End] {
			if line[0] == '+' || line[0] == '-' {
				changed++
			}
		}
		if changed > MaxChangedLinesPerUnit {
			t.Fatalf("unit %s carries %d changed lines, limit is %d", unit.ID, changed, MaxChangedLinesPerUnit)
		}
		total += changed
	}
	if total != changedLines {
		t.Fatalf("split covers %d changed lines, want %d", total, changedLines)
	}
}

func planTestChanges() []Change {
	return []Change{
		{
			ID: "c_a", Status: "modified", OldPath: "a.go", NewPath: "a.go", Source: "workspace",
			Hunks: []Hunk{{
				OldStart: 1, OldCount: 1, NewStart: 1, NewCount: 2,
				Header: "@@ -1,1 +1,2 @@",
				Lines:  []string{"-old", "+new", "+extra"},
			}},
		},
		{ID: "c_b", Status: "added", NewPath: "b.go", Source: "workspace"},
		{ID: "c_test", Status: "added", NewPath: "a_test.go", Source: "workspace"},
		{ID: "c_vendor", Status: "modified", OldPath: "vendor/lib.go", NewPath: "vendor/lib.go", Source: "workspace"},
		{ID: "c_del", Status: "deleted", OldPath: "deleted.go", Source: "workspace"},
	}
}

func findUnitByKind(t *testing.T, units []Unit, kind string) Unit {
	t.Helper()
	for _, unit := range units {
		if unit.Kind == kind {
			return unit
		}
	}
	t.Fatalf("no %s unit in %+v", kind, units)
	return Unit{}
}

func findFileUnit(t *testing.T, units []Unit, path string) Unit {
	t.Helper()
	for _, unit := range units {
		if unit.Kind == UnitFile && len(unit.Paths) == 1 && unit.Paths[0] == path {
			return unit
		}
	}
	t.Fatalf("no file unit for %s in %+v", path, units)
	return Unit{}
}

func findExcluded(t *testing.T, excluded []ExcludedEntry, path string) ExcludedEntry {
	t.Helper()
	for _, entry := range excluded {
		if entry.Path == path {
			return entry
		}
	}
	t.Fatalf("no exclusion for %s in %+v", path, excluded)
	return ExcludedEntry{}
}

func hasUnitPath(units []Unit, path string) bool {
	for _, unit := range units {
		if containsString(unit.Paths, path) {
			return true
		}
	}
	return false
}

func containsString(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}
