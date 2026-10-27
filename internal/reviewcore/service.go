// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package reviewcore

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
)

// ErrReplay tells the store to return the loaded run without writing. Service
// code sets the replayed flag before returning it.
var ErrReplay = errors.New("idempotent replay")

// FileContent is a whole snapshot file.
type FileContent struct {
	Path       string
	Side       string
	Content    string
	Lines      []string
	TotalLines int
	Digest     string
	Binary     bool
	TooLarge   bool
}

// FileChunk is a line range from a snapshot file.
type FileChunk struct {
	Path       string
	Side       string
	Content    string
	LineStart  int
	LineEnd    int
	TotalLines int
	Digest     string
	Binary     bool
}

// FileInfo describes one readable snapshot file.
type FileInfo struct {
	Path   string
	Side   string
	Digest string
	Size   int64
	Binary bool
}

// SearchOptions bounds a snapshot search.
type SearchOptions struct {
	Query         string
	CaseSensitive bool
	Regex         bool
	PathPrefix    string
	Side          string
	Offset        int
	Limit         int
}

// Reader is the immutable snapshot access surface.
type Reader interface {
	LineSource
	ReadFile(ctx context.Context, path, side string) (FileContent, error)
	ReadFileLines(ctx context.Context, path, side string, startLine, maxLines int) (FileChunk, error)
	Diff(ctx context.Context, changeID string) (string, error)
	UnitDiff(ctx context.Context, unit Unit) (string, error)
	Search(ctx context.Context, options SearchOptions) (matches []SearchMatch, total, scanned, skipped int, err error)
	ListFiles(ctx context.Context, side, prefix string, offset, limit int) ([]FileInfo, int, error)
}

// Repository freezes inputs and opens immutable readers.
type Repository interface {
	Prepare(ctx context.Context, input InputSpec, scope Scope) (*Snapshot, error)
	Open(snapshot *Snapshot) (Reader, error)
	Rules(ctx context.Context, reader Reader, paths []string) (*RulePack, error)
}

// Store persists runs with atomic updates and request-key deduplication.
type Store interface {
	CreateRun(ctx context.Context, run *Run, requestKey, requestHash string) (*Run, bool, error)
	LoadRun(ctx context.Context, reviewID string) (*Run, error)
	UpdateRun(ctx context.Context, reviewID string, update func(*Run) error) (*Run, error)
}

// AssetSource publishes the Skill and Agent definitions executed by Peri.
type AssetSource interface {
	Skill() AssetDoc
	Agents() []AssetDoc
	Digest() string
}

// Config wires the service.
type Config struct {
	Repo            Repository
	Store           Store
	Assets          AssetSource
	DefaultPageSize int
	MaxPageSize     int
	MaxBodyBytes    int
	Clock           func() time.Time
}

// Service implements the six review tools. It never invokes a model.
type Service struct {
	repo            Repository
	store           Store
	assets          AssetSource
	defaultPageSize int
	maxPageSize     int
	maxBodyBytes    int
	clock           func() time.Time
}

// NewService validates dependencies and applies defaults.
func NewService(config Config) (*Service, error) {
	if config.Repo == nil || config.Store == nil || config.Assets == nil {
		return nil, fmt.Errorf("review service requires repo, store and assets")
	}
	service := &Service{
		repo:            config.Repo,
		store:           config.Store,
		assets:          config.Assets,
		defaultPageSize: config.DefaultPageSize,
		maxPageSize:     config.MaxPageSize,
		maxBodyBytes:    config.MaxBodyBytes,
		clock:           config.Clock,
	}
	if service.defaultPageSize <= 0 {
		service.defaultPageSize = 20
	}
	if service.maxPageSize <= 0 {
		service.maxPageSize = 200
	}
	if service.maxBodyBytes <= 0 {
		service.maxBodyBytes = 64 * 1024
	}
	if service.clock == nil {
		service.clock = time.Now
	}
	return service, nil
}

func (s *Service) now() time.Time { return s.clock().UTC() }

// Prepare creates or replays a run and returns the first page of units.
func (s *Service) Prepare(ctx context.Context, req PrepareRequest) (*PrepareResponse, error) {
	scopeGiven := req.Scope != nil
	normalized, err := NormalizePrepare(req)
	if err != nil {
		return nil, err
	}
	scope, err := NormalizeScope(normalized.Scope)
	if err != nil {
		return nil, err
	}
	requestHash, err := CanonicalHash(struct {
		Input      *InputSpec `json:"input,omitempty"`
		Scope      Scope      `json:"scope"`
		Background string     `json:"background,omitempty"`
		ResumeFrom string     `json:"resume_from,omitempty"`
	}{normalized.Input, scope, normalized.Background, normalized.ResumeFrom})
	if err != nil {
		return nil, err
	}

	input := InputSpec{}
	if normalized.Input != nil {
		input = *normalized.Input
	}
	background := normalized.Background
	var parent *Run
	resume := false

	if normalized.ResumeFrom != "" {
		parent, err = s.store.LoadRun(ctx, normalized.ResumeFrom)
		if err != nil {
			return nil, err
		}
		if parent.Snapshot == nil {
			return nil, Errorf(CodeSnapshotMissing, "run %s has no snapshot", parent.ReviewID)
		}
		if normalized.Input == nil {
			input = parent.Input
		}
		compatible := SameInput(input, parent.Input) &&
			(!scopeGiven || SameScope(scope, parent.Scope)) &&
			parent.AssetsDigest == s.assets.Digest()
		if compatible {
			resume = true
			if !scopeGiven {
				scope = parent.Scope
			}
			if background == "" {
				background = parent.Background
			}
		}
	}
	if input.Mode == "" {
		return nil, Errorf(CodeInvalidInput, "input is required unless resume_from supplies it")
	}

	if resume {
		run, created, createErr := s.createResumedRun(ctx, parent, scope, background, normalized.RequestKey, requestHash)
		if createErr != nil {
			return nil, createErr
		}
		return s.prepareResponse(run, !created), nil
	}

	snapshot, err := s.repo.Prepare(ctx, input, scope)
	if err != nil {
		return nil, err
	}
	reader, err := s.repo.Open(snapshot)
	if err != nil {
		return nil, err
	}
	paths := changedPaths(snapshot.Changes)
	pack, err := s.repo.Rules(ctx, reader, paths)
	if err != nil {
		return nil, err
	}
	units, excluded := PlanUnits(snapshot.Changes, scope, pack)
	excluded = mergeExcluded(snapshot.Excluded, excluded)
	snapshot.Excluded = excluded

	reviewID, err := NewID("rv_")
	if err != nil {
		return nil, err
	}
	now := s.now()
	run := &Run{
		SchemaVersion: SchemaVersion,
		ReviewID:      reviewID,
		Input:         input,
		Scope:         scope,
		Background:    background,
		Snapshot:      snapshot,
		RulesDigest:   pack.Digest,
		AssetsDigest:  s.assets.Digest(),
		Status:        RunActive,
		Units:         units,
		Requests:      map[string]RequestRecord{},
		CreatedAt:     now,
		UpdatedAt:     now,
		Version:       1,
	}
	saved, created, err := s.store.CreateRun(ctx, run, normalized.RequestKey, requestHash)
	if err != nil {
		return nil, err
	}
	return s.prepareResponse(saved, !created), nil
}

func (s *Service) createResumedRun(ctx context.Context, parent *Run, scope Scope, background, requestKey, requestHash string) (*Run, bool, error) {
	reviewID, err := NewID("rv_")
	if err != nil {
		return nil, false, err
	}
	now := s.now()
	run := &Run{
		SchemaVersion:  SchemaVersion,
		ReviewID:       reviewID,
		ParentReviewID: parent.ReviewID,
		Input:          parent.Input,
		Scope:          scope,
		Background:     background,
		Snapshot:       cloneSnapshot(parent.Snapshot),
		RulesDigest:    parent.RulesDigest,
		AssetsDigest:   parent.AssetsDigest,
		Status:         RunActive,
		Requests:       map[string]RequestRecord{},
		CreatedAt:      now,
		UpdatedAt:      now,
		Version:        1,
	}
	reusedFindings := map[string]bool{}
	for _, unit := range parent.Units {
		copyUnit := unit
		copyUnit.Slices = append([]HunkSlice(nil), unit.Slices...)
		copyUnit.Paths = append([]string(nil), unit.Paths...)
		copyUnit.ChangeIDs = append([]string(nil), unit.ChangeIDs...)
		copyUnit.RuleRefs = append([]RuleRef(nil), unit.RuleRefs...)
		if unit.Status == UnitReviewed {
			copyUnit.Reused = true
			copyUnit.ReusedFrom = parent.ReviewID
			reusedFindings[unit.ID] = true
		} else {
			copyUnit.Status = UnitPending
			copyUnit.Reason = ""
			copyUnit.Reused = false
			copyUnit.ReusedFrom = ""
			copyUnit.SubmissionKey = ""
			copyUnit.SubmissionHash = ""
			copyUnit.SubmittedAt = nil
		}
		run.Units = append(run.Units, copyUnit)
	}
	for _, finding := range parent.Findings {
		if reusedFindings[finding.UnitID] {
			run.Findings = append(run.Findings, finding)
		}
	}
	for _, verification := range parent.Verifications {
		for _, finding := range run.Findings {
			if verification.FindingID == finding.ID {
				run.Verifications = append(run.Verifications, verification)
				break
			}
		}
	}
	return s.store.CreateRun(ctx, run, requestKey, requestHash)
}

func (s *Service) prepareResponse(run *Run, replayed bool) *PrepareResponse {
	limit := s.defaultPageSize
	units, next := pageUnits(run.Units, 0, limit, run)
	excluded := run.Snapshot.Excluded
	if len(excluded) > limit {
		excluded = excluded[:limit]
	}
	return &PrepareResponse{
		SchemaVersion:  SchemaVersion,
		ReviewID:       run.ReviewID,
		ParentReviewID: run.ParentReviewID,
		Status:         run.Status,
		Snapshot:       run.Snapshot.Summarize(),
		Input:          run.Input,
		Scope:          run.Scope,
		Background:     run.Background,
		RulesDigest:    run.RulesDigest,
		AssetsDigest:   run.AssetsDigest,
		Counts:         run.Count(),
		Units:          units,
		NextCursor:     next,
		Excluded:       append([]ExcludedEntry(nil), excluded...),
		ExcludedCount:  len(run.Snapshot.Excluded),
		Replayed:       replayed,
	}
}

func pageUnits(units []Unit, offset, limit int, run *Run) ([]UnitSummary, string) {
	if offset < 0 {
		offset = 0
	}
	if offset > len(units) {
		offset = len(units)
	}
	end := offset + limit
	if end > len(units) {
		end = len(units)
	}
	out := make([]UnitSummary, 0, end-offset)
	for _, unit := range units[offset:end] {
		out = append(out, unit.Summary())
	}
	next := ""
	if end < len(units) {
		next = EncodeCursor(run.ReviewID, run.Snapshot.ID, QueryHash("status", "units"), end, 0)
	}
	return out, next
}

func changedPaths(changes []Change) []string {
	seen := map[string]bool{}
	var paths []string
	for _, change := range changes {
		for _, p := range []string{change.OldPath, change.NewPath} {
			if p != "" && !seen[p] {
				seen[p] = true
				paths = append(paths, p)
			}
		}
	}
	sort.Strings(paths)
	return paths
}

func cloneSnapshot(snapshot *Snapshot) *Snapshot {
	if snapshot == nil {
		return nil
	}
	clone := *snapshot
	clone.Changes = append([]Change(nil), snapshot.Changes...)
	for i := range clone.Changes {
		clone.Changes[i].Hunks = append([]Hunk(nil), snapshot.Changes[i].Hunks...)
		for j := range clone.Changes[i].Hunks {
			clone.Changes[i].Hunks[j].Lines = append([]string(nil), snapshot.Changes[i].Hunks[j].Lines...)
		}
	}
	clone.Files = append([]FileRecord(nil), snapshot.Files...)
	clone.Excluded = append([]ExcludedEntry(nil), snapshot.Excluded...)
	return &clone
}

func mergeExcluded(sets ...[]ExcludedEntry) []ExcludedEntry {
	seen := map[string]bool{}
	var out []ExcludedEntry
	for _, set := range sets {
		for _, entry := range set {
			key := entry.Path + "\x00" + entry.Side + "\x00" + entry.Reason
			if !seen[key] {
				seen[key] = true
				out = append(out, entry)
			}
		}
	}
	return out
}

func findUnit(run *Run, unitID string) *Unit {
	for i := range run.Units {
		if run.Units[i].ID == unitID {
			return &run.Units[i]
		}
	}
	return nil
}

func findFinding(run *Run, findingID string) *Finding {
	for i := range run.Findings {
		if run.Findings[i].ID == findingID {
			return &run.Findings[i]
		}
	}
	return nil
}

func unitAllowsPath(run *Run, unit *Unit, path string) bool {
	if unit.Kind == UnitCrossFile {
		for _, file := range run.Snapshot.Files {
			if file.Path == path {
				return true
			}
		}
		return false
	}
	for _, candidate := range unit.Paths {
		if candidate == path {
			return true
		}
	}
	for _, changeID := range unit.ChangeIDs {
		for _, change := range run.Snapshot.Changes {
			if change.ID == changeID && (change.OldPath == path || change.NewPath == path) {
				return true
			}
		}
	}
	return false
}

func defaultSide(unit *Unit) string {
	if unit.Side != "" {
		return unit.Side
	}
	return SideNew
}

func validateOutcome(outcome string) error {
	switch outcome {
	case UnitReviewed, UnitSkipped, UnitFailed:
		return nil
	default:
		return Errorf(CodeInvalidArgument, "outcome must be reviewed, skipped or failed")
	}
}

func validCategory(value string) bool {
	switch value {
	case CategoryCorrectness, CategorySecurity, CategoryPerformance,
		CategoryMaintainability, CategoryTesting, CategoryRedundancy:
		return true
	}
	return false
}

func validPriority(value string) bool {
	switch value {
	case PriorityP0, PriorityP1, PriorityP2, PriorityP3:
		return true
	}
	return false
}

func validateVerdict(value string) bool {
	switch value {
	case VerdictConfirmed, VerdictRejected, VerdictUnresolved:
		return true
	}
	return false
}

func truncateText(value string, max int) string {
	value = strings.TrimSpace(value)
	if len(value) <= max {
		return value
	}
	return value[:max]
}
