// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package reviewcore

import (
	"fmt"
	"time"
)

// ComputeCoverage counts every unit, including skipped and failed ones, in the
// denominator. Only reviewed units count as covered.
func ComputeCoverage(run *Run) Coverage {
	coverage := Coverage{Required: len(run.Units)}
	for _, unit := range run.Units {
		entry := UnitCoverage{
			UnitID: unit.ID, Kind: unit.Kind, Paths: unit.Paths,
			Status: unit.Status, Reason: unit.Reason, Reused: unit.Reused,
		}
		coverage.Units = append(coverage.Units, entry)
		switch unit.Status {
		case UnitReviewed:
			coverage.Reviewed++
			if unit.Reused {
				coverage.Reused++
			}
		case UnitSkipped:
			coverage.Skipped++
		case UnitFailed:
			coverage.Failed++
		default:
			coverage.Pending++
		}
	}
	coverage.Complete = coverage.Reviewed == coverage.Required
	return coverage
}

// Gaps lists reasons a finalize request must be rejected. The messages are
// stable enough to display in a report.
func Gaps(run *Run) []string {
	var gaps []string
	for _, unit := range run.Units {
		switch unit.Status {
		case UnitPending:
			gaps = append(gaps, fmt.Sprintf("unit %s (%s) is still pending", unit.ID, unitPath(unit)))
		case UnitSkipped:
			gaps = append(gaps, fmt.Sprintf("unit %s (%s) was skipped: %s", unit.ID, unitPath(unit), unit.Reason))
		case UnitFailed:
			gaps = append(gaps, fmt.Sprintf("unit %s (%s) failed: %s", unit.ID, unitPath(unit), unit.Reason))
		}
	}
	for _, finding := range run.Findings {
		if LatestVerification(run, finding.ID) == nil {
			gaps = append(gaps, fmt.Sprintf("finding %s has no verification verdict", finding.ID))
		}
	}
	return gaps
}

func unitPath(unit Unit) string {
	if len(unit.Paths) == 0 {
		return "cross-file"
	}
	if len(unit.Paths) == 1 {
		return unit.Paths[0]
	}
	return fmt.Sprintf("%s (+%d files)", unit.Paths[0], len(unit.Paths)-1)
}

// LatestVerification returns the most recent verdict for a finding.
func LatestVerification(run *Run, findingID string) *VerificationRecord {
	for i := len(run.Verifications) - 1; i >= 0; i-- {
		if run.Verifications[i].FindingID == findingID {
			record := run.Verifications[i]
			return &record
		}
	}
	return nil
}

// FindingsFor returns finding views with their latest verification.
func FindingsFor(run *Run) []FindingView {
	views := make([]FindingView, 0, len(run.Findings))
	for _, finding := range run.Findings {
		views = append(views, FindingView{Finding: finding, LatestVerification: LatestVerification(run, finding.ID)})
	}
	return views
}

// SealStatus maps a finish intent to the terminal run status.
func SealStatus(intent string) (string, error) {
	switch intent {
	case IntentFinalize:
		return RunCompleted, nil
	case IntentClosePartial:
		return RunPartial, nil
	case IntentCancel:
		return RunCancelled, nil
	default:
		return "", Errorf(CodeInvalidArgument, "unknown finish intent %q", intent)
	}
}

// ValidateFinalize rejects finalization until every unit is reviewed and every
// finding has a recorded verdict.
func ValidateFinalize(run *Run) error {
	gaps := Gaps(run)
	if len(gaps) > 0 {
		return Errorf(CodeReviewIncomplete, "review has %d incomplete item(s)", len(gaps)).WithDetails(gaps)
	}
	return nil
}

// BuildReport derives the report from the run; it never mutates state.
func BuildReport(run *Run, now time.Time) *Report {
	report := &Report{
		SchemaVersion:  SchemaVersion,
		ReviewID:       run.ReviewID,
		ParentReviewID: run.ParentReviewID,
		Status:         run.Status,
		Terminal:       run.Status,
		Snapshot:       run.Snapshot.Summarize(),
		Input:          run.Input,
		Scope:          run.Scope,
		Background:     run.Background,
		RulesDigest:    run.RulesDigest,
		AssetsDigest:   run.AssetsDigest,
		Coverage:       ComputeCoverage(run),
		Verifications:  append([]VerificationRecord(nil), run.Verifications...),
		Excluded:       append([]ExcludedEntry(nil), run.Snapshot.Excluded...),
		Gaps:           Gaps(run),
		GeneratedAt:    now,
	}
	for _, view := range FindingsFor(run) {
		report.Findings = append(report.Findings, ReportFinding{
			Finding: view.Finding, LatestVerification: view.LatestVerification,
		})
	}
	return report
}
