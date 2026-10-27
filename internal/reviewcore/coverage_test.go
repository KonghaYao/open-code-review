// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package reviewcore

import (
	"errors"
	"strings"
	"testing"
	"time"
)

func TestComputeCoverageCountsEveryStatus(t *testing.T) {
	run := &Run{Units: []Unit{
		{ID: "u1", Kind: UnitFile, Paths: []string{"a.go"}, Status: UnitReviewed, Reused: true},
		{ID: "u2", Kind: UnitFile, Paths: []string{"b.go"}, Status: UnitReviewed},
		{ID: "u3", Kind: UnitCrossFile, Status: UnitSkipped, Reason: "out of time"},
		{ID: "u4", Kind: UnitFile, Paths: []string{"c.go"}, Status: UnitFailed, Reason: "tool error"},
		{ID: "u5", Kind: UnitFile, Paths: []string{"d.go"}, Status: UnitPending},
	}}

	coverage := ComputeCoverage(run)
	if coverage.Required != 5 || coverage.Reviewed != 2 || coverage.Reused != 1 ||
		coverage.Skipped != 1 || coverage.Failed != 1 || coverage.Pending != 1 {
		t.Fatalf("unexpected coverage: %+v", coverage)
	}
	if coverage.Complete {
		t.Fatal("coverage must not be complete while units are pending or failed")
	}
	if len(coverage.Units) != 5 {
		t.Fatalf("unit coverage entries = %d, want 5", len(coverage.Units))
	}
	if coverage.Units[0].UnitID != "u1" || coverage.Units[0].Reused != true ||
		len(coverage.Units[0].Paths) != 1 || coverage.Units[0].Paths[0] != "a.go" {
		t.Fatalf("unexpected unit coverage: %+v", coverage.Units[0])
	}
}

func TestComputeCoverageComplete(t *testing.T) {
	run := &Run{Units: []Unit{
		{ID: "u1", Kind: UnitFile, Status: UnitReviewed},
		{ID: "u2", Kind: UnitCrossFile, Status: UnitReviewed},
	}}
	coverage := ComputeCoverage(run)
	if !coverage.Complete || coverage.Reviewed != 2 || coverage.Required != 2 {
		t.Fatalf("unexpected coverage: %+v", coverage)
	}

	empty := ComputeCoverage(&Run{})
	if !empty.Complete || empty.Required != 0 {
		t.Fatalf("empty run coverage = %+v, want vacuously complete", empty)
	}
	if err := ValidateFinalize(&Run{}); err != nil {
		t.Fatalf("empty run must be finalizable: %v", err)
	}
}

func TestGapsListsIncompleteUnitsAndUnverifiedFindings(t *testing.T) {
	run := &Run{
		Units: []Unit{
			{ID: "u1", Kind: UnitFile, Paths: []string{"a.go"}, Status: UnitPending},
			{ID: "u2", Kind: UnitFile, Paths: []string{"b.go"}, Status: UnitSkipped, Reason: "out of time"},
			{ID: "u3", Kind: UnitCrossFile, Status: UnitFailed, Reason: "tool error"},
		},
		Findings: []Finding{{ID: "f1"}},
	}

	gaps := Gaps(run)
	if len(gaps) != 4 {
		t.Fatalf("gaps = %#v, want four entries", gaps)
	}
	joined := strings.Join(gaps, "\n")
	for _, want := range []string{"u1", "still pending", "u2", "out of time", "u3", "tool error", "f1", "no verification verdict"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("gaps missing %q:\n%s", want, joined)
		}
	}

	run.Verifications = append(run.Verifications, VerificationRecord{FindingID: "f1", Verdict: VerdictConfirmed})
	if gaps := Gaps(run); len(gaps) != 3 {
		t.Fatalf("gaps after verification = %#v, want three unit entries", gaps)
	}
}

func TestLatestVerificationAndFindingsFor(t *testing.T) {
	first := VerificationRecord{ID: "v1", FindingID: "f1", Verdict: VerdictUnresolved, At: time.Unix(1, 0)}
	second := VerificationRecord{ID: "v2", FindingID: "f1", Verdict: VerdictConfirmed, At: time.Unix(2, 0)}
	run := &Run{
		Findings:      []Finding{{ID: "f1"}, {ID: "f2"}},
		Verifications: []VerificationRecord{first, second},
	}

	if latest := LatestVerification(run, "f1"); latest == nil || latest.ID != "v2" {
		t.Fatalf("latest verification = %+v, want v2", latest)
	}
	if latest := LatestVerification(run, "f2"); latest != nil {
		t.Fatalf("latest verification for f2 = %+v, want nil", latest)
	}

	views := FindingsFor(run)
	if len(views) != 2 {
		t.Fatalf("finding views = %d, want 2", len(views))
	}
	if views[0].LatestVerification == nil || views[0].LatestVerification.ID != "v2" {
		t.Fatalf("finding view = %+v", views[0])
	}
	if views[1].LatestVerification != nil {
		t.Fatalf("finding view f2 = %+v", views[1])
	}
}

func TestValidateFinalize(t *testing.T) {
	complete := &Run{Units: []Unit{
		{ID: "u1", Kind: UnitFile, Status: UnitReviewed},
		{ID: "u2", Kind: UnitCrossFile, Status: UnitReviewed},
	}}
	if err := ValidateFinalize(complete); err != nil {
		t.Fatalf("ValidateFinalize(complete) = %v", err)
	}

	incomplete := &Run{Units: []Unit{{ID: "u1", Kind: UnitFile, Status: UnitPending}}}
	err := ValidateFinalize(incomplete)
	if !IsCode(err, CodeReviewIncomplete) {
		t.Fatalf("ValidateFinalize(incomplete) = %v, want %s", err, CodeReviewIncomplete)
	}
	var business *Error
	if !errors.As(err, &business) {
		t.Fatalf("error is not a business error: %v", err)
	}
	details, ok := business.Details.([]string)
	if !ok || len(details) != 1 {
		t.Fatalf("details = %#v, want one gap", business.Details)
	}

	unverified := &Run{
		Units:    []Unit{{ID: "u1", Kind: UnitFile, Status: UnitReviewed}},
		Findings: []Finding{{ID: "f1"}},
	}
	if err := ValidateFinalize(unverified); !IsCode(err, CodeReviewIncomplete) {
		t.Fatalf("ValidateFinalize(unverified) = %v, want %s", err, CodeReviewIncomplete)
	}
}

func TestSealStatus(t *testing.T) {
	tests := []struct {
		intent string
		want   string
		code   ErrorCode
	}{
		{intent: IntentFinalize, want: RunCompleted},
		{intent: IntentClosePartial, want: RunPartial},
		{intent: IntentCancel, want: RunCancelled},
		{intent: "unknown", code: CodeInvalidArgument},
	}
	for _, test := range tests {
		t.Run(test.intent, func(t *testing.T) {
			status, err := SealStatus(test.intent)
			if test.code != "" {
				if !IsCode(err, test.code) {
					t.Fatalf("error = %v, want %s", err, test.code)
				}
				return
			}
			if err != nil {
				t.Fatalf("SealStatus: %v", err)
			}
			if status != test.want {
				t.Fatalf("status = %q, want %q", status, test.want)
			}
		})
	}
}
