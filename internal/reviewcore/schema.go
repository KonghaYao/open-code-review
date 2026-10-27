// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

// Package reviewcore holds the model-independent review domain: inputs,
// snapshot metadata, review units, findings, coverage and terminal state.
//
// It must not import the original OCR agent, LLM or CLI packages. Transport
// adapters (reviewmcp) and infrastructure (reviewrepo, reviewstore) depend on
// this package, never the other way around.
package reviewcore

// SchemaVersion is carried by every tool result and persisted run.
const SchemaVersion = "peri-code-review/v1"

// Input modes accepted by review_prepare.
const (
	ModeRange     = "range"
	ModeCommit    = "commit"
	ModeWorkspace = "workspace"
)

// Run status values. A run stays active until review_finish seals it.
const (
	RunActive    = "active"
	RunCompleted = "completed"
	RunPartial   = "partial"
	RunCancelled = "cancelled"
)

// Unit kinds.
const (
	UnitFile      = "file"
	UnitCrossFile = "cross_file"
)

// Unit outcome/status values.
const (
	UnitPending  = "pending"
	UnitReviewed = "reviewed"
	UnitSkipped  = "skipped"
	UnitFailed   = "failed"
)

// Finding categories.
const (
	CategoryCorrectness     = "correctness"
	CategorySecurity        = "security"
	CategoryPerformance     = "performance"
	CategoryMaintainability = "maintainability"
	CategoryTesting         = "testing"
	CategoryRedundancy      = "redundancy"
)

// Priorities follow the project convention P0 (highest) through P3.
const (
	PriorityP0 = "P0"
	PriorityP1 = "P1"
	PriorityP2 = "P2"
	PriorityP3 = "P3"
)

// Verification verdicts.
const (
	VerdictConfirmed  = "confirmed"
	VerdictRejected   = "rejected"
	VerdictUnresolved = "unresolved"
)

// Finish intents.
const (
	IntentFinalize     = "finalize"
	IntentClosePartial = "close_partial"
	IntentCancel       = "cancel"
)

// Sides identify the old or new version of a change.
const (
	SideOld = "old"
	SideNew = "new"
)

// ExcludedReasons explains why a change or file does not enter the review.
const (
	ExcludeBinary      = "binary"
	ExcludeSecret      = "secret_path"
	ExcludeDefaultPath = "default_exclude"
	ExcludeUserExclude = "user_exclude"
	ExcludeTests       = "tests_excluded"
	ExcludeDeleted     = "deleted_excluded"
	ExcludeTooLarge    = "too_large"
	ExcludeProvider    = "provider_directory"
	ExcludeUnsupported = "unsupported"
)
