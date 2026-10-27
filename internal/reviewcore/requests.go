// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package reviewcore

import "time"

// PrepareRequest starts a review or resumes completed work from a previous
// run. RequestKey makes preparation idempotent across transport retries.
type PrepareRequest struct {
	Input      *InputSpec `json:"input,omitempty"`
	Scope      *ScopeSpec `json:"scope,omitempty"`
	Background string     `json:"background,omitempty"`
	RequestKey string     `json:"request_key"`
	ResumeFrom string     `json:"resume_from,omitempty"`
}

// PrepareResponse returns the frozen snapshot and the first page of units.
type PrepareResponse struct {
	SchemaVersion  string          `json:"schema_version"`
	ReviewID       string          `json:"review_id"`
	ParentReviewID string          `json:"parent_review_id,omitempty"`
	Status         string          `json:"status"`
	Snapshot       SnapshotSummary `json:"snapshot"`
	Input          InputSpec       `json:"input"`
	Scope          Scope           `json:"scope"`
	Background     string          `json:"background,omitempty"`
	RulesDigest    string          `json:"rules_digest"`
	AssetsDigest   string          `json:"assets_digest"`
	Counts         Counts          `json:"counts"`
	Units          []UnitSummary   `json:"units,omitempty"`
	NextCursor     string          `json:"next_cursor,omitempty"`
	Excluded       []ExcludedEntry `json:"excluded,omitempty"`
	ExcludedCount  int             `json:"excluded_count"`
	Replayed       bool            `json:"replayed,omitempty"`
}

// ContextRequest reads only from the frozen snapshot. Kind is one of unit,
// diff, file, manifest, search or rules.
type ContextRequest struct {
	ReviewID      string `json:"review_id"`
	Kind          string `json:"kind"`
	UnitID        string `json:"unit_id,omitempty"`
	ChangeID      string `json:"change_id,omitempty"`
	Path          string `json:"path,omitempty"`
	Side          string `json:"side,omitempty"`
	StartLine     int    `json:"start_line,omitempty"`
	EndLine       int    `json:"end_line,omitempty"`
	Limit         int    `json:"limit,omitempty"`
	Cursor        string `json:"cursor,omitempty"`
	Query         string `json:"query,omitempty"`
	CaseSensitive bool   `json:"case_sensitive,omitempty"`
	Regex         bool   `json:"regex,omitempty"`
	PathPrefix    string `json:"path_prefix,omitempty"`
}

// ContextResponse carries exactly one payload kind plus common metadata.
type ContextResponse struct {
	SchemaVersion string        `json:"schema_version"`
	ReviewID      string        `json:"review_id"`
	SnapshotID    string        `json:"snapshot_id"`
	Kind          string        `json:"kind"`
	Unit          *UnitDetail   `json:"unit,omitempty"`
	Diff          *DiffView     `json:"diff,omitempty"`
	File          *FileView     `json:"file,omitempty"`
	Manifest      *ManifestView `json:"manifest,omitempty"`
	Search        *SearchView   `json:"search,omitempty"`
	Rules         []RuleGroup   `json:"rules,omitempty"`
	NextCursor    string        `json:"next_cursor,omitempty"`
}

// UnitDetail is a unit plus its bounded diff and resolved rules.
type UnitDetail struct {
	UnitSummary
	Diff      string      `json:"diff"`
	DiffBytes int         `json:"diff_bytes"`
	Rules     []RuleGroup `json:"rules,omitempty"`
}

// DiffView is a line-paginated diff.
type DiffView struct {
	ChangeID   string `json:"change_id,omitempty"`
	UnitID     string `json:"unit_id,omitempty"`
	Path       string `json:"path,omitempty"`
	Content    string `json:"content"`
	LineStart  int    `json:"line_start"`
	LineEnd    int    `json:"line_end"`
	TotalLines int    `json:"total_lines"`
	Bytes      int    `json:"bytes"`
}

// FileView is a line-paginated snapshot file.
type FileView struct {
	Path       string `json:"path"`
	Side       string `json:"side"`
	Content    string `json:"content"`
	LineStart  int    `json:"line_start"`
	LineEnd    int    `json:"line_end"`
	TotalLines int    `json:"total_lines"`
	Bytes      int    `json:"bytes"`
	Digest     string `json:"digest"`
	Binary     bool   `json:"binary,omitempty"`
}

// ManifestView lists changes and units without file bodies.
type ManifestView struct {
	Changes      []ChangeSummary `json:"changes"`
	Units        []UnitSummary   `json:"units"`
	TotalChanges int             `json:"total_changes"`
	TotalUnits   int             `json:"total_units"`
}

// SearchMatch is one deterministic hit inside the snapshot.
type SearchMatch struct {
	Path    string `json:"path"`
	Side    string `json:"side"`
	Line    int    `json:"line"`
	EndLine int    `json:"end_line"`
	Excerpt string `json:"excerpt"`
	Digest  string `json:"digest"`
}

// SearchView is a page of search hits.
type SearchView struct {
	Query        string        `json:"query"`
	Matches      []SearchMatch `json:"matches"`
	Total        int           `json:"total"`
	ScannedFiles int           `json:"scanned_files"`
	SkippedFiles int           `json:"skipped_files"`
}

// SubmitRequest atomically commits one unit outcome and its findings.
type SubmitRequest struct {
	ReviewID   string         `json:"review_id"`
	UnitID     string         `json:"unit_id"`
	Outcome    string         `json:"outcome"`
	Reason     string         `json:"reason,omitempty"`
	Findings   []FindingInput `json:"findings,omitempty"`
	RequestKey string         `json:"request_key"`
}

// FindingView adds the latest verification to a stored finding.
type FindingView struct {
	Finding
	LatestVerification *VerificationRecord `json:"latest_verification,omitempty"`
}

// SubmitResponse returns the committed unit state.
type SubmitResponse struct {
	SchemaVersion string        `json:"schema_version"`
	ReviewID      string        `json:"review_id"`
	UnitID        string        `json:"unit_id"`
	Outcome       string        `json:"outcome"`
	Unit          UnitSummary   `json:"unit"`
	Findings      []FindingView `json:"findings,omitempty"`
	Counts        Counts        `json:"counts"`
	Replayed      bool          `json:"replayed,omitempty"`
}

// VerifyRequest records one review verdict and detects revision conflicts.
type VerifyRequest struct {
	ReviewID         string        `json:"review_id"`
	FindingID        string        `json:"finding_id"`
	Verdict          string        `json:"verdict"`
	Rationale        string        `json:"rationale"`
	Evidence         []EvidenceRef `json:"evidence,omitempty"`
	ExpectedRevision int64         `json:"expected_revision"`
	RequestKey       string        `json:"request_key"`
}

// VerifyResponse returns the new verification and the updated finding.
type VerifyResponse struct {
	SchemaVersion string             `json:"schema_version"`
	ReviewID      string             `json:"review_id"`
	Verification  VerificationRecord `json:"verification"`
	Finding       FindingView        `json:"finding"`
	Replayed      bool               `json:"replayed,omitempty"`
}

// StatusRequest reads run progress. Section is one of summary, coverage,
// units, findings, verifications, report or gaps.
type StatusRequest struct {
	ReviewID string `json:"review_id"`
	Section  string `json:"section,omitempty"`
	Cursor   string `json:"cursor,omitempty"`
	Limit    int    `json:"limit,omitempty"`
}

// StatusSummary is the compact status section.
type StatusSummary struct {
	Status         string          `json:"status"`
	Terminal       string          `json:"terminal,omitempty"`
	ParentReviewID string          `json:"parent_review_id,omitempty"`
	Snapshot       SnapshotSummary `json:"snapshot"`
	Input          InputSpec       `json:"input"`
	Scope          Scope           `json:"scope"`
	Background     string          `json:"background,omitempty"`
	RulesDigest    string          `json:"rules_digest"`
	AssetsDigest   string          `json:"assets_digest"`
	Counts         Counts          `json:"counts"`
	Seal           *Seal           `json:"seal,omitempty"`
}

// StatusResponse carries exactly one status section.
type StatusResponse struct {
	SchemaVersion string               `json:"schema_version"`
	ReviewID      string               `json:"review_id"`
	Status        string               `json:"status"`
	Summary       *StatusSummary       `json:"summary,omitempty"`
	Coverage      *Coverage            `json:"coverage,omitempty"`
	Units         []UnitSummary        `json:"units,omitempty"`
	Findings      []FindingView        `json:"findings,omitempty"`
	Verifications []VerificationRecord `json:"verifications,omitempty"`
	Report        *Report              `json:"report,omitempty"`
	Gaps          []string             `json:"gaps,omitempty"`
	NextCursor    string               `json:"next_cursor,omitempty"`
}

// FinishRequest seals a run. Finalize requires complete coverage; the other
// intents preserve partial results explicitly.
type FinishRequest struct {
	ReviewID   string `json:"review_id"`
	Intent     string `json:"intent"`
	Reason     string `json:"reason,omitempty"`
	RequestKey string `json:"request_key"`
}

// FinishResponse returns terminal state and stable report URIs.
type FinishResponse struct {
	SchemaVersion     string    `json:"schema_version"`
	ReviewID          string    `json:"review_id"`
	Status            string    `json:"status"`
	Intent            string    `json:"intent"`
	Coverage          Coverage  `json:"coverage"`
	Gaps              []string  `json:"gaps,omitempty"`
	ReportJSONURI     string    `json:"report_json_uri"`
	ReportMarkdownURI string    `json:"report_markdown_uri"`
	SealedAt          time.Time `json:"sealed_at"`
	Replayed          bool      `json:"replayed,omitempty"`
}

// AssetResource is one file belonging to a published skill.
type AssetResource struct {
	URI    string `json:"uri"`
	Digest string `json:"digest"`
}

// AssetDoc is a Skill or Agent definition published by this server.
type AssetDoc struct {
	URI         string          `json:"uri"`
	Name        string          `json:"name"`
	Description string          `json:"description"`
	MIMEType    string          `json:"mime_type"`
	Content     string          `json:"content"`
	Digest      string          `json:"digest"`
	Frontmatter map[string]any  `json:"frontmatter"`
	Resources   []AssetResource `json:"resources,omitempty"`
}
