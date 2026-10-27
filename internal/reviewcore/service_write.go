// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package reviewcore

import (
	"context"
	"errors"
	"regexp"
	"strings"
)

var findingIDPattern = regexp.MustCompile(`^fnd_[0-9a-f]{16,64}$`)

// Submit atomically commits a unit result. Any invalid finding rejects the
// whole batch and leaves the run unchanged.
func (s *Service) Submit(ctx context.Context, req SubmitRequest) (*SubmitResponse, error) {
	if err := validateReviewID(req.ReviewID); err != nil {
		return nil, err
	}
	req.UnitID = strings.TrimSpace(req.UnitID)
	req.Outcome = strings.ToLower(strings.TrimSpace(req.Outcome))
	req.Reason = strings.TrimSpace(req.Reason)
	if req.UnitID == "" {
		return nil, Errorf(CodeInvalidArgument, "unit_id is required")
	}
	if err := ValidateRequestKey(req.RequestKey); err != nil {
		return nil, err
	}
	if err := validateOutcome(req.Outcome); err != nil {
		return nil, err
	}
	if req.Outcome != UnitReviewed && len(req.Findings) > 0 {
		return nil, Errorf(CodeInvalidArgument, "findings are only allowed when outcome is reviewed")
	}
	if req.Outcome != UnitReviewed && req.Reason == "" {
		return nil, Errorf(CodeInvalidArgument, "reason is required when a unit is skipped or failed")
	}
	if len(req.Findings) > 100 {
		return nil, Errorf(CodeInvalidArgument, "a unit may submit at most 100 findings")
	}
	requestHash, err := CanonicalHash(struct {
		ReviewID string         `json:"review_id"`
		UnitID   string         `json:"unit_id"`
		Outcome  string         `json:"outcome"`
		Reason   string         `json:"reason"`
		Findings []FindingInput `json:"findings"`
	}{req.ReviewID, req.UnitID, req.Outcome, req.Reason, req.Findings})
	if err != nil {
		return nil, err
	}

	replayed := false
	var newFindings []Finding
	updated, err := s.store.UpdateRun(ctx, req.ReviewID, func(run *Run) error {
		if run.Seal != nil {
			return Errorf(CodeRunSealed, "run is sealed as %s", run.Status)
		}
		if record, ok := run.Requests[req.RequestKey]; ok {
			if record.Hash != requestHash {
				return Errorf(CodeIdempotencyConflict, "request_key was already used with a different body")
			}
			replayed = true
			return ErrReplay
		}
		unit := findUnit(run, req.UnitID)
		if unit == nil {
			return Errorf(CodeInvalidArgument, "unknown unit_id")
		}
		if unit.Status != UnitPending {
			if unit.SubmissionHash == requestHash {
				replayed = true
				return ErrReplay
			}
			return Errorf(CodeIdempotencyConflict, "unit %s already has a terminal result", unit.ID)
		}
		reader, openErr := s.repo.Open(run.Snapshot)
		if openErr != nil {
			return openErr
		}
		findings, buildErr := s.buildFindings(ctx, run, reader, unit, req.Findings)
		if buildErr != nil {
			return buildErr
		}
		now := s.now()
		unit.Status = req.Outcome
		unit.Reason = req.Reason
		unit.SubmissionKey = req.RequestKey
		unit.SubmissionHash = requestHash
		unit.SubmittedAt = &now
		run.Findings = append(run.Findings, findings...)
		run.Requests[req.RequestKey] = RequestRecord{Hash: requestHash, ResultID: unit.ID, At: now}
		run.UpdatedAt = now
		newFindings = findings
		return nil
	})
	if err != nil {
		return nil, err
	}
	unit := findUnit(updated, req.UnitID)
	if unit == nil {
		return nil, Errorf(CodeStateCorrupt, "committed unit is missing")
	}
	views := newFindings
	if replayed {
		views = nil
		for _, finding := range updated.Findings {
			if finding.UnitID == req.UnitID {
				views = append(views, finding)
			}
		}
	}
	return &SubmitResponse{
		SchemaVersion: SchemaVersion,
		ReviewID:      updated.ReviewID,
		UnitID:        unit.ID,
		Outcome:       unit.Status,
		Unit:          unit.Summary(),
		Findings:      findingViews(updated, views),
		Counts:        updated.Count(),
		Replayed:      replayed,
	}, nil
}

func (s *Service) buildFindings(ctx context.Context, run *Run, reader Reader, unit *Unit, inputs []FindingInput) ([]Finding, error) {
	findings := make([]Finding, 0, len(inputs))
	side := defaultSide(unit)
	for _, input := range inputs {
		input.Category = strings.ToLower(strings.TrimSpace(input.Category))
		input.Priority = strings.ToUpper(strings.TrimSpace(input.Priority))
		input.Trigger = strings.TrimSpace(input.Trigger)
		input.Impact = strings.TrimSpace(input.Impact)
		input.Suggestion = strings.TrimSpace(input.Suggestion)
		if !validCategory(input.Category) {
			return nil, Errorf(CodeInvalidArgument, "unknown finding category %q", input.Category)
		}
		if !validPriority(input.Priority) {
			return nil, Errorf(CodeInvalidArgument, "unknown finding priority %q", input.Priority)
		}
		if input.Trigger == "" || input.Impact == "" {
			return nil, Errorf(CodeInvalidArgument, "finding trigger and impact are required")
		}
		if len(input.Trigger) > 4000 || len(input.Impact) > 4000 || len(input.Suggestion) > 8000 {
			return nil, Errorf(CodeInvalidArgument, "finding text exceeds the per-field limit")
		}
		location := input.Location
		location.Path = normalizePath(location.Path)
		if location.Path == "" {
			return nil, Errorf(CodeInvalidAnchor, "finding location.path is required")
		}
		if !unitAllowsPath(run, unit, location.Path) {
			return nil, Errorf(CodePathOutOfScope, "finding path %q is outside unit %s", location.Path, unit.ID)
		}
		if isSecretPath(location.Path) {
			return nil, Errorf(CodeSecretPath, "secret paths cannot be findings")
		}
		if strings.TrimSpace(location.Snippet) == "" {
			return nil, Errorf(CodeInvalidAnchor, "finding location.snippet is required")
		}
		anchor, anchorErr := ResolveAnchor(ctx, reader, location, side)
		if anchorErr != nil {
			return nil, anchorErr
		}
		evidence := make([]EvidenceRef, 0, len(input.Evidence))
		for _, ref := range input.Evidence {
			resolved, evidenceErr := ResolveEvidence(ctx, reader, ref, anchor.Location.Side)
			if evidenceErr != nil {
				return nil, evidenceErr
			}
			evidence = append(evidence, resolved)
		}
		id, idErr := NewID("fnd_")
		if idErr != nil {
			return nil, idErr
		}
		findings = append(findings, Finding{
			ID: id, UnitID: unit.ID, Category: input.Category, Priority: input.Priority,
			Trigger: input.Trigger, Impact: input.Impact, Suggestion: input.Suggestion,
			Location: anchor.Location, Digest: anchor.Digest, Located: anchor.Located,
			LocateNote: anchor.Note, Evidence: evidence, Revision: 1, CreatedAt: s.now(),
		})
	}
	return findings, nil
}

func findingViews(run *Run, findings []Finding) []FindingView {
	views := make([]FindingView, 0, len(findings))
	for _, finding := range findings {
		views = append(views, FindingView{Finding: finding, LatestVerification: LatestVerification(run, finding.ID)})
	}
	return views
}

// Verify appends one verdict and uses the finding revision to reject stale
// concurrent writes. Rejected and unresolved verdicts are retained.
func (s *Service) Verify(ctx context.Context, req VerifyRequest) (*VerifyResponse, error) {
	if err := validateReviewID(req.ReviewID); err != nil {
		return nil, err
	}
	req.FindingID = strings.TrimSpace(req.FindingID)
	req.Verdict = strings.ToLower(strings.TrimSpace(req.Verdict))
	req.Rationale = strings.TrimSpace(req.Rationale)
	if !findingIDPattern.MatchString(req.FindingID) {
		return nil, Errorf(CodeInvalidArgument, "invalid finding_id")
	}
	if err := ValidateRequestKey(req.RequestKey); err != nil {
		return nil, err
	}
	if !validateVerdict(req.Verdict) {
		return nil, Errorf(CodeInvalidArgument, "verdict must be confirmed, rejected or unresolved")
	}
	if req.Rationale == "" {
		return nil, Errorf(CodeInvalidArgument, "rationale is required")
	}
	if len(req.Rationale) > 8000 {
		return nil, Errorf(CodeInvalidArgument, "rationale is longer than 8000 bytes")
	}
	if req.ExpectedRevision < 1 {
		return nil, Errorf(CodeInvalidArgument, "expected_revision must be at least 1")
	}
	requestHash, err := CanonicalHash(struct {
		ReviewID         string        `json:"review_id"`
		FindingID        string        `json:"finding_id"`
		Verdict          string        `json:"verdict"`
		Rationale        string        `json:"rationale"`
		Evidence         []EvidenceRef `json:"evidence"`
		ExpectedRevision int64         `json:"expected_revision"`
	}{req.ReviewID, req.FindingID, req.Verdict, req.Rationale, req.Evidence, req.ExpectedRevision})
	if err != nil {
		return nil, err
	}

	replayed := false
	updated, err := s.store.UpdateRun(ctx, req.ReviewID, func(run *Run) error {
		if run.Seal != nil {
			return Errorf(CodeRunSealed, "run is sealed as %s", run.Status)
		}
		if record, ok := run.Requests[req.RequestKey]; ok {
			if record.Hash != requestHash {
				return Errorf(CodeIdempotencyConflict, "request_key was already used with a different body")
			}
			replayed = true
			return ErrReplay
		}
		finding := findFinding(run, req.FindingID)
		if finding == nil {
			return Errorf(CodeInvalidArgument, "unknown finding_id")
		}
		if finding.Revision != req.ExpectedRevision {
			return Errorf(CodeRevisionConflict, "finding revision is %d, expected %d", finding.Revision, req.ExpectedRevision).
				WithDetails(map[string]any{"current_revision": finding.Revision})
		}
		reader, openErr := s.repo.Open(run.Snapshot)
		if openErr != nil {
			return openErr
		}
		evidence := make([]EvidenceRef, 0, len(req.Evidence))
		for _, ref := range req.Evidence {
			resolved, evidenceErr := ResolveEvidence(ctx, reader, ref, finding.Location.Side)
			if evidenceErr != nil {
				return evidenceErr
			}
			evidence = append(evidence, resolved)
		}
		id, idErr := NewID("ver_")
		if idErr != nil {
			return idErr
		}
		now := s.now()
		record := VerificationRecord{
			ID: id, FindingID: finding.ID, Verdict: req.Verdict,
			Rationale: req.Rationale, Evidence: evidence,
			FindingRevision: finding.Revision, RequestKey: req.RequestKey, At: now,
		}
		run.Verifications = append(run.Verifications, record)
		finding.Revision++
		run.Requests[req.RequestKey] = RequestRecord{Hash: requestHash, ResultID: record.ID, At: now}
		run.UpdatedAt = now
		return nil
	})
	if err != nil {
		return nil, err
	}
	finding := findFinding(updated, req.FindingID)
	if finding == nil {
		return nil, Errorf(CodeStateCorrupt, "verified finding is missing")
	}
	record := LatestVerification(updated, req.FindingID)
	if replayed {
		if stored, ok := updated.Requests[req.RequestKey]; ok {
			record = verificationByID(updated, stored.ResultID)
		}
	}
	if record == nil {
		return nil, Errorf(CodeStateCorrupt, "verification record is missing")
	}
	return &VerifyResponse{
		SchemaVersion: SchemaVersion, ReviewID: updated.ReviewID,
		Verification: *record,
		Finding:      FindingView{Finding: *finding, LatestVerification: record},
		Replayed:     replayed,
	}, nil
}

func verificationByID(run *Run, id string) *VerificationRecord {
	for i := range run.Verifications {
		if run.Verifications[i].ID == id {
			record := run.Verifications[i]
			return &record
		}
	}
	return nil
}

// Status returns one bounded status section. It is safe to call before or
// after sealing.
func (s *Service) Status(ctx context.Context, req StatusRequest) (*StatusResponse, error) {
	if err := validateReviewID(req.ReviewID); err != nil {
		return nil, err
	}
	run, err := s.store.LoadRun(ctx, req.ReviewID)
	if err != nil {
		return nil, err
	}
	section := strings.ToLower(strings.TrimSpace(req.Section))
	if section == "" {
		section = "summary"
	}
	query := QueryHash("status", section)
	offset, _, err := DecodeCursor(req.Cursor, run.ReviewID, snapshotID(run), query)
	if err != nil {
		return nil, err
	}
	limit := ClampLimit(req.Limit, s.defaultPageSize, s.maxPageSize)
	response := &StatusResponse{SchemaVersion: SchemaVersion, ReviewID: run.ReviewID, Status: run.Status}
	switch section {
	case "summary":
		response.Summary = &StatusSummary{
			Status: run.Status, Terminal: run.Status, ParentReviewID: run.ParentReviewID,
			Snapshot: run.Snapshot.Summarize(), Input: run.Input, Scope: run.Scope,
			Background: run.Background, RulesDigest: run.RulesDigest,
			AssetsDigest: run.AssetsDigest, Counts: run.Count(), Seal: run.Seal,
		}
	case "coverage":
		coverage := ComputeCoverage(run)
		start, end := pageBounds(len(coverage.Units), offset, limit)
		coverage.Units = coverage.Units[start:end]
		response.Coverage = &coverage
		if end < len(run.Units) {
			response.NextCursor = EncodeCursor(run.ReviewID, snapshotID(run), query, end, 0)
		}
	case "units":
		start, end := pageBounds(len(run.Units), offset, limit)
		for _, unit := range run.Units[start:end] {
			response.Units = append(response.Units, unit.Summary())
		}
		if end < len(run.Units) {
			response.NextCursor = EncodeCursor(run.ReviewID, snapshotID(run), query, end, 0)
		}
	case "findings":
		views := FindingsFor(run)
		start, end := pageBounds(len(views), offset, limit)
		response.Findings = views[start:end]
		if end < len(views) {
			response.NextCursor = EncodeCursor(run.ReviewID, snapshotID(run), query, end, 0)
		}
	case "verifications":
		start, end := pageBounds(len(run.Verifications), offset, limit)
		response.Verifications = append(response.Verifications, run.Verifications[start:end]...)
		if end < len(run.Verifications) {
			response.NextCursor = EncodeCursor(run.ReviewID, snapshotID(run), query, end, 0)
		}
	case "report":
		response.Report = BuildReport(run, s.now())
	case "gaps":
		response.Gaps = Gaps(run)
	default:
		return nil, Errorf(CodeInvalidArgument, "unknown status section %q", section)
	}
	return response, nil
}

// Finish seals a run. Finalize is rejected until coverage is complete; the
// partial and cancel intents preserve explicit gaps in the report.
func (s *Service) Finish(ctx context.Context, req FinishRequest) (*FinishResponse, error) {
	if err := validateReviewID(req.ReviewID); err != nil {
		return nil, err
	}
	req.Intent = strings.ToLower(strings.TrimSpace(req.Intent))
	req.Reason = strings.TrimSpace(req.Reason)
	if err := ValidateRequestKey(req.RequestKey); err != nil {
		return nil, err
	}
	status, err := SealStatus(req.Intent)
	if err != nil {
		return nil, err
	}
	if req.Intent == IntentClosePartial && req.Reason == "" {
		return nil, Errorf(CodeInvalidArgument, "reason is required when closing a partial review")
	}
	requestHash, err := CanonicalHash(struct {
		ReviewID string `json:"review_id"`
		Intent   string `json:"intent"`
		Reason   string `json:"reason"`
	}{req.ReviewID, req.Intent, req.Reason})
	if err != nil {
		return nil, err
	}
	replayed := false
	updated, err := s.store.UpdateRun(ctx, req.ReviewID, func(run *Run) error {
		if record, ok := run.Requests[req.RequestKey]; ok {
			if record.Hash != requestHash {
				return Errorf(CodeIdempotencyConflict, "request_key was already used with a different body")
			}
			replayed = true
			return ErrReplay
		}
		if run.Seal != nil {
			return Errorf(CodeRunSealed, "run is already sealed as %s", run.Status)
		}
		if req.Intent == IntentFinalize {
			if finalizeErr := ValidateFinalize(run); finalizeErr != nil {
				return finalizeErr
			}
		}
		now := s.now()
		run.Status = status
		run.Seal = &Seal{Intent: req.Intent, Status: status, At: now, Reason: req.Reason}
		run.Requests[req.RequestKey] = RequestRecord{Hash: requestHash, ResultID: status, At: now}
		run.UpdatedAt = now
		return nil
	})
	if err != nil {
		return nil, err
	}
	if updated.Seal == nil {
		return nil, Errorf(CodeStateCorrupt, "sealed run has no seal record")
	}
	jsonURI, markdownURI := ReportURIs(updated.ReviewID)
	return &FinishResponse{
		SchemaVersion: SchemaVersion, ReviewID: updated.ReviewID,
		Status: updated.Status, Intent: req.Intent, Coverage: ComputeCoverage(updated),
		Gaps: Gaps(updated), ReportJSONURI: jsonURI, ReportMarkdownURI: markdownURI,
		SealedAt: updated.Seal.At, Replayed: replayed,
	}, nil
}

// Report returns the derived report and its markdown rendering.
func (s *Service) Report(ctx context.Context, reviewID string) (*Report, string, error) {
	if err := validateReviewID(reviewID); err != nil {
		return nil, "", err
	}
	run, err := s.store.LoadRun(ctx, reviewID)
	if err != nil {
		return nil, "", err
	}
	report := BuildReport(run, s.now())
	return report, RenderMarkdown(report), nil
}

func snapshotID(run *Run) string {
	if run.Snapshot == nil {
		return ""
	}
	return run.Snapshot.ID
}

var _ = errors.Is
