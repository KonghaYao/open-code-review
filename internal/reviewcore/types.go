// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package reviewcore

import "time"

// InputSpec is the normalized review input. Exactly one mode is set.
type InputSpec struct {
	Mode   string `json:"mode"`
	From   string `json:"from,omitempty"`
	To     string `json:"to,omitempty"`
	Commit string `json:"commit,omitempty"`
}

// ScopeSpec is the caller-provided review scope. Nil booleans mean "default",
// which is to include tests and deleted-file impact.
type ScopeSpec struct {
	IncludeTests   *bool    `json:"include_tests,omitempty"`
	IncludeDeleted *bool    `json:"include_deleted,omitempty"`
	Include        []string `json:"include,omitempty"`
	Exclude        []string `json:"exclude,omitempty"`
}

// Scope is the normalized scope stored with a run.
type Scope struct {
	IncludeTests   bool     `json:"include_tests"`
	IncludeDeleted bool     `json:"include_deleted"`
	Include        []string `json:"include,omitempty"`
	Exclude        []string `json:"exclude,omitempty"`
}

// Hunk is one unified-diff hunk. Lines keep their raw diff prefix.
type Hunk struct {
	OldStart int      `json:"old_start"`
	OldCount int      `json:"old_count"`
	NewStart int      `json:"new_start"`
	NewCount int      `json:"new_count"`
	Header   string   `json:"header"`
	Lines    []string `json:"lines"`
}

// Change is one changed path in the frozen snapshot. OldPath or NewPath may be
// empty for additions and deletions.
type Change struct {
	ID            string `json:"change_id"`
	Status        string `json:"status"`
	OldPath       string `json:"old_path,omitempty"`
	NewPath       string `json:"new_path,omitempty"`
	Source        string `json:"source"`
	Binary        bool   `json:"binary,omitempty"`
	IsTest        bool   `json:"is_test,omitempty"`
	Insertions    int    `json:"insertions"`
	Deletions     int    `json:"deletions"`
	OldDigest     string `json:"old_digest,omitempty"`
	NewDigest     string `json:"new_digest,omitempty"`
	Diff          string `json:"diff,omitempty"`
	DiffTruncated bool   `json:"diff_truncated,omitempty"`
	Hunks         []Hunk `json:"hunks,omitempty"`
}

// EffectivePath is the new path, falling back to the old path for deletions.
func (c Change) EffectivePath() string {
	if c.NewPath != "" {
		return c.NewPath
	}
	return c.OldPath
}

// FileRecord describes a file on one side of the snapshot.
type FileRecord struct {
	Path     string `json:"path"`
	Side     string `json:"side"`
	Digest   string `json:"digest"`
	Size     int64  `json:"size"`
	Binary   bool   `json:"binary,omitempty"`
	TooLarge bool   `json:"too_large,omitempty"`
}

// ExcludedEntry records why a path was not reviewable. It is part of the
// report, not an error.
type ExcludedEntry struct {
	Path   string `json:"path"`
	Side   string `json:"side"`
	Reason string `json:"reason"`
	Source string `json:"source,omitempty"`
}

// Snapshot is the immutable input a run is bound to. RepoRoot and WorkspaceDir
// are internal locations and must never be exposed by tools.
type Snapshot struct {
	ID           string          `json:"snapshot_id"`
	Mode         string          `json:"mode"`
	RepoRoot     string          `json:"repo_root"`
	BaseSHA      string          `json:"base_sha,omitempty"`
	HeadSHA      string          `json:"head_sha,omitempty"`
	MergeBaseSHA string          `json:"merge_base_sha,omitempty"`
	InputDigest  string          `json:"input_digest"`
	Changes      []Change        `json:"changes"`
	Files        []FileRecord    `json:"files"`
	Excluded     []ExcludedEntry `json:"excluded,omitempty"`
	WorkspaceDir string          `json:"workspace_dir,omitempty"`
	CreatedAt    time.Time       `json:"created_at"`
}

// SnapshotSummary is the model-visible snapshot metadata.
type SnapshotSummary struct {
	ID           string `json:"snapshot_id"`
	Mode         string `json:"mode"`
	BaseSHA      string `json:"base_sha,omitempty"`
	HeadSHA      string `json:"head_sha,omitempty"`
	MergeBaseSHA string `json:"merge_base_sha,omitempty"`
	InputDigest  string `json:"input_digest"`
	ChangeCount  int    `json:"change_count"`
	FileCount    int    `json:"file_count"`
}

// Summarize hides internal snapshot locations.
func (s *Snapshot) Summarize() SnapshotSummary {
	if s == nil {
		return SnapshotSummary{}
	}
	return SnapshotSummary{
		ID:           s.ID,
		Mode:         s.Mode,
		BaseSHA:      s.BaseSHA,
		HeadSHA:      s.HeadSHA,
		MergeBaseSHA: s.MergeBaseSHA,
		InputDigest:  s.InputDigest,
		ChangeCount:  len(s.Changes),
		FileCount:    len(s.Files),
	}
}

// HunkSlice selects part of one hunk. Start and End are zero-based indexes
// into Hunk.Lines and End is exclusive.
type HunkSlice struct {
	HunkIndex int `json:"hunk_index"`
	Start     int `json:"start"`
	End       int `json:"end"`
}

// Unit is the atomic assignment handed to a review role.
type Unit struct {
	ID             string      `json:"unit_id"`
	Kind           string      `json:"kind"`
	ChangeIDs      []string    `json:"change_ids,omitempty"`
	Paths          []string    `json:"paths,omitempty"`
	Side           string      `json:"side,omitempty"`
	StartLine      int         `json:"start_line,omitempty"`
	EndLine        int         `json:"end_line,omitempty"`
	Slices         []HunkSlice `json:"slices,omitempty"`
	FullFile       bool        `json:"full_file,omitempty"`
	RuleRefs       []RuleRef   `json:"rule_refs,omitempty"`
	Status         string      `json:"status"`
	Reason         string      `json:"reason,omitempty"`
	Reused         bool        `json:"reused,omitempty"`
	ReusedFrom     string      `json:"reused_from,omitempty"`
	SubmissionKey  string      `json:"submission_key,omitempty"`
	SubmissionHash string      `json:"submission_hash,omitempty"`
	SubmittedAt    *time.Time  `json:"submitted_at,omitempty"`
}

// RuleRef identifies the rule that applied to a unit without repeating its text.
type RuleRef struct {
	Source  string `json:"source"`
	Pattern string `json:"pattern"`
}

// RuleGroup is a bundle of files that share the same rule text.
type RuleGroup struct {
	Source  string   `json:"source"`
	Pattern string   `json:"pattern"`
	Text    string   `json:"text"`
	Files   []string `json:"files"`
}

// RulePack is the rules resolved from one snapshot, together with the project
// file filter loaded from that same snapshot.
type RulePack struct {
	Digest  string      `json:"digest"`
	Groups  []RuleGroup `json:"groups"`
	Include []string    `json:"include,omitempty"`
	Exclude []string    `json:"exclude,omitempty"`
}

// Location is a model-supplied anchor. Snippet is required for deterministic
// relocation; the server never trusts StartLine/EndLine on their own.
type Location struct {
	Path      string `json:"path"`
	Side      string `json:"side,omitempty"`
	StartLine int    `json:"start_line"`
	EndLine   int    `json:"end_line"`
	Snippet   string `json:"snippet"`
}

// EvidenceRef cites supporting code. It may point at an unchanged file.
type EvidenceRef struct {
	Path      string `json:"path"`
	Side      string `json:"side,omitempty"`
	StartLine int    `json:"start_line,omitempty"`
	EndLine   int    `json:"end_line,omitempty"`
	Snippet   string `json:"snippet,omitempty"`
	Digest    string `json:"digest,omitempty"`
	Note      string `json:"note,omitempty"`
	Located   bool   `json:"located"`
}

// FindingInput is the caller-supplied finding before id assignment and
// deterministic anchor validation.
type FindingInput struct {
	Category   string        `json:"category"`
	Priority   string        `json:"priority"`
	Trigger    string        `json:"trigger"`
	Impact     string        `json:"impact"`
	Suggestion string        `json:"suggestion,omitempty"`
	Location   Location      `json:"location"`
	Evidence   []EvidenceRef `json:"evidence,omitempty"`
}

// Finding is the stored candidate issue. Revision is bumped by verification.
type Finding struct {
	ID         string        `json:"finding_id"`
	UnitID     string        `json:"unit_id"`
	Category   string        `json:"category"`
	Priority   string        `json:"priority"`
	Trigger    string        `json:"trigger"`
	Impact     string        `json:"impact"`
	Suggestion string        `json:"suggestion,omitempty"`
	Location   Location      `json:"location"`
	Digest     string        `json:"digest,omitempty"`
	Located    bool          `json:"located"`
	LocateNote string        `json:"locate_note,omitempty"`
	Evidence   []EvidenceRef `json:"evidence,omitempty"`
	Revision   int64         `json:"revision"`
	CreatedAt  time.Time     `json:"created_at"`
}

// VerificationRecord preserves every review decision. Rejected and
// unresolved findings are retained, never silently deleted.
type VerificationRecord struct {
	ID              string        `json:"verification_id"`
	FindingID       string        `json:"finding_id"`
	Verdict         string        `json:"verdict"`
	Rationale       string        `json:"rationale"`
	Evidence        []EvidenceRef `json:"evidence,omitempty"`
	FindingRevision int64         `json:"finding_revision"`
	RequestKey      string        `json:"request_key"`
	At              time.Time     `json:"at"`
}

// Seal records how a run reached a terminal state.
type Seal struct {
	Intent string    `json:"intent"`
	Status string    `json:"status"`
	At     time.Time `json:"at"`
	Reason string    `json:"reason,omitempty"`
}

// RequestRecord is the per-run idempotency ledger. Hash binds a request_key to
// one canonical request; a different body under the same key is a conflict.
type RequestRecord struct {
	Hash     string    `json:"hash"`
	ResultID string    `json:"result_id,omitempty"`
	At       time.Time `json:"at"`
}

// Run is the complete persisted business state of one review.
type Run struct {
	SchemaVersion  string                   `json:"schema_version"`
	ReviewID       string                   `json:"review_id"`
	ParentReviewID string                   `json:"parent_review_id,omitempty"`
	Input          InputSpec                `json:"input"`
	Scope          Scope                    `json:"scope"`
	Background     string                   `json:"background,omitempty"`
	Snapshot       *Snapshot                `json:"snapshot"`
	RulesDigest    string                   `json:"rules_digest"`
	AssetsDigest   string                   `json:"assets_digest"`
	Status         string                   `json:"status"`
	Units          []Unit                   `json:"units"`
	Findings       []Finding                `json:"findings"`
	Verifications  []VerificationRecord     `json:"verifications"`
	Requests       map[string]RequestRecord `json:"requests"`
	Seal           *Seal                    `json:"seal,omitempty"`
	CreatedAt      time.Time                `json:"created_at"`
	UpdatedAt      time.Time                `json:"updated_at"`
	Version        int64                    `json:"version"`
}

// Counts is the run rollup returned by preparation and status.
type Counts struct {
	Changes        int `json:"changes"`
	Units          int `json:"units"`
	RequiredUnits  int `json:"required_units"`
	CrossFileUnits int `json:"cross_file_units"`
	Excluded       int `json:"excluded"`
	Findings       int `json:"findings"`
	Verifications  int `json:"verifications"`
}

// Count summarizes the run.
func (r *Run) Count() Counts {
	counts := Counts{Findings: len(r.Findings), Verifications: len(r.Verifications)}
	if r.Snapshot != nil {
		counts.Changes = len(r.Snapshot.Changes)
		counts.Excluded = len(r.Snapshot.Excluded)
	}
	for _, unit := range r.Units {
		counts.Units++
		if unit.Kind == UnitCrossFile {
			counts.CrossFileUnits++
		}
		counts.RequiredUnits++
	}
	return counts
}

// UnitSummary is a bounded unit view for tool results.
type UnitSummary struct {
	ID        string    `json:"unit_id"`
	Kind      string    `json:"kind"`
	ChangeIDs []string  `json:"change_ids,omitempty"`
	Paths     []string  `json:"paths,omitempty"`
	Side      string    `json:"side,omitempty"`
	StartLine int       `json:"start_line,omitempty"`
	EndLine   int       `json:"end_line,omitempty"`
	RuleRefs  []RuleRef `json:"rule_refs,omitempty"`
	Status    string    `json:"status"`
	Reason    string    `json:"reason,omitempty"`
	Reused    bool      `json:"reused,omitempty"`
}

func (u Unit) Summary() UnitSummary {
	return UnitSummary{
		ID: u.ID, Kind: u.Kind, ChangeIDs: u.ChangeIDs, Paths: u.Paths,
		Side: u.Side, StartLine: u.StartLine, EndLine: u.EndLine,
		RuleRefs: u.RuleRefs, Status: u.Status, Reason: u.Reason, Reused: u.Reused,
	}
}

// ChangeSummary is a bounded change view for manifest pages.
type ChangeSummary struct {
	ID         string `json:"change_id"`
	Status     string `json:"status"`
	OldPath    string `json:"old_path,omitempty"`
	NewPath    string `json:"new_path,omitempty"`
	Source     string `json:"source"`
	Binary     bool   `json:"binary,omitempty"`
	IsTest     bool   `json:"is_test,omitempty"`
	Insertions int    `json:"insertions"`
	Deletions  int    `json:"deletions"`
	DiffBytes  int    `json:"diff_bytes"`
}

func (c Change) Summary() ChangeSummary {
	return ChangeSummary{
		ID: c.ID, Status: c.Status, OldPath: c.OldPath, NewPath: c.NewPath,
		Source: c.Source, Binary: c.Binary, IsTest: c.IsTest,
		Insertions: c.Insertions, Deletions: c.Deletions, DiffBytes: len(c.Diff),
	}
}

// UnitCoverage is one unit's contribution to coverage.
type UnitCoverage struct {
	UnitID string   `json:"unit_id"`
	Kind   string   `json:"kind"`
	Paths  []string `json:"paths,omitempty"`
	Status string   `json:"status"`
	Reason string   `json:"reason,omitempty"`
	Reused bool     `json:"reused,omitempty"`
}

// Coverage is the run's completion accounting. Skipped, failed and pending
// units remain in the denominator.
type Coverage struct {
	Required int            `json:"required"`
	Reviewed int            `json:"reviewed"`
	Reused   int            `json:"reused"`
	Skipped  int            `json:"skipped"`
	Failed   int            `json:"failed"`
	Pending  int            `json:"pending"`
	Complete bool           `json:"complete"`
	Units    []UnitCoverage `json:"units"`
}

// ReportFinding is a finding with its latest verification.
type ReportFinding struct {
	Finding
	LatestVerification *VerificationRecord `json:"latest_verification,omitempty"`
}

// Report is derived from run state; it is never a second source of truth.
type Report struct {
	SchemaVersion  string               `json:"schema_version"`
	ReviewID       string               `json:"review_id"`
	ParentReviewID string               `json:"parent_review_id,omitempty"`
	Status         string               `json:"status"`
	Terminal       string               `json:"terminal"`
	Snapshot       SnapshotSummary      `json:"snapshot"`
	Input          InputSpec            `json:"input"`
	Scope          Scope                `json:"scope"`
	Background     string               `json:"background,omitempty"`
	RulesDigest    string               `json:"rules_digest"`
	AssetsDigest   string               `json:"assets_digest"`
	Coverage       Coverage             `json:"coverage"`
	Findings       []ReportFinding      `json:"findings"`
	Verifications  []VerificationRecord `json:"verifications"`
	Excluded       []ExcludedEntry      `json:"excluded,omitempty"`
	Gaps           []string             `json:"gaps,omitempty"`
	GeneratedAt    time.Time            `json:"generated_at"`
}
