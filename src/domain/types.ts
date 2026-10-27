// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
/**
 * Public domain contracts for the three MCP tools and the data handed between
 * the review, verification and aggregation phases.
 *
 * Tool names are snake_case; every JSON field is camelCase.
 */

export const REVIEW_MODES = ['range', 'commit', 'workspace'] as const;
export type ReviewMode = (typeof REVIEW_MODES)[number];

export const COMPARISONS = ['merge-base', 'first-parent', 'workspace-vs-head'] as const;
export type Comparison = (typeof COMPARISONS)[number];

export const CHANGE_SIDES = ['base', 'head', 'workspace'] as const;
export type ChangeSide = (typeof CHANGE_SIDES)[number];

export const UNIT_KINDS = ['file', 'cross_file'] as const;
export type UnitKind = (typeof UNIT_KINDS)[number];

export const UNIT_STATUSES = ['pending', 'reviewed', 'failed', 'skipped'] as const;
export type UnitStatus = (typeof UNIT_STATUSES)[number];

export const UNIT_RESULT_STATUSES = ['reviewed', 'failed', 'skipped'] as const;
export type UnitResultStatus = (typeof UNIT_RESULT_STATUSES)[number];

export const RULE_SOURCES = ['system', 'project'] as const;
export type RuleSource = (typeof RULE_SOURCES)[number];

export const EXCLUSION_REASONS = [
  'binary',
  'secret_path',
  'default_exclude',
  'user_exclude',
  'tests_excluded',
  'deleted_excluded',
  'too_large',
  'provider_directory',
  'unsupported',
] as const;
export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];

export const CATEGORIES = ['correctness', 'security', 'performance', 'maintainability', 'testing', 'redundancy'] as const;
export type Category = (typeof CATEGORIES)[number];

export const PRIORITIES = ['P0', 'P1', 'P2', 'P3'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const VERDICTS = ['confirmed', 'rejected', 'unresolved'] as const;
export type Verdict = (typeof VERDICTS)[number];

export const COMPLETIONS = ['complete', 'partial'] as const;
export type Completion = (typeof COMPLETIONS)[number];

export const OUTCOMES = ['clean', 'findings', 'inconclusive', 'noChanges'] as const;
export type Outcome = (typeof OUTCOMES)[number];

export const EXPORT_FORMATS = ['json', 'markdown'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const EXPORT_STATUSES = ['exported', 'partial'] as const;
export type ExportStatus = (typeof EXPORT_STATUSES)[number];

export const REVIEW_STAGES = ['review', 'verify', 'aggregate'] as const;
export type ReviewStage = (typeof REVIEW_STAGES)[number];

export const ATTEMPT_STATUSES = ['succeeded', 'failed'] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

export interface ReviewInput {
  mode: ReviewMode;
  /** range mode: inclusive start ref. */
  from?: string;
  /** range mode: inclusive end ref. */
  to?: string;
  /** commit mode: the commit under review. */
  commit?: string;
}

export interface RequestedRefs {
  from?: string;
  to?: string;
  commit?: string;
}

/**
 * The immutable Git identity bound to one review. `repoRoot` is deliberately
 * absent: it is only used for local lookup and must never be sent to a client.
 */
export interface ReviewSource {
  repoId: string;
  mode: ReviewMode;
  requestedRefs?: RequestedRefs;
  baseSha: string;
  headSha: string;
  mergeBaseSha?: string;
  comparison: Comparison;
  /** Present only for workspace mode. */
  workspaceFingerprint?: string;
}

export interface ReviewScope {
  include?: string[];
  exclude?: string[];
  /** Defaults to true. */
  includeTests?: boolean;
  /** Defaults to true. */
  includeDeleted?: boolean;
}

export interface NormalizedReviewScope {
  include: string[];
  exclude: string[];
  includeTests: boolean;
  includeDeleted: boolean;
}

export interface DiffSlice {
  hunkIndex: number;
  start: number;
  end: number;
}

export interface RuleRef {
  source: RuleSource;
  pattern: string;
}

export interface ReviewUnit {
  unitId: string;
  kind: UnitKind;
  changeIds: string[];
  paths: string[];
  /** Paths that a cross-file or dependency-sensitive unit must inspect. */
  relatedPaths: string[];
  side: ChangeSide;
  startLine: number;
  endLine: number;
  slices: DiffSlice[];
  fullFile: boolean;
  ruleRefs: RuleRef[];
  status: UnitStatus;
  reason?: string;
}

export interface ExcludedPath {
  path: string;
  side?: ChangeSide;
  reason: ExclusionReason;
  source?: string;
}

/** Input of the `prepare_code_review` tool. */
export interface PrepareCodeReviewInput {
  input: ReviewInput;
  scope?: ReviewScope;
  background?: string;
  /** Opaque cursor bound to this exact input and source. */
  cursor?: string;
}

/** Output of the `prepare_code_review` tool. */
export interface PrepareCodeReviewOutput {
  source: ReviewSource;
  scope: NormalizedReviewScope;
  background?: string;
  units: ReviewUnit[];
  excluded: ExcludedPath[];
  manifestDigest: string;
  totalUnits: number;
  rulesDigest: string;
  skillDigests: Record<string, string>;
  serverVersion: string;
  reviewKey: string;
  nextCursor?: string;
}

/** A reproducible manifest that can be rebuilt from `source` and `scope`. */
export interface ReviewManifest {
  reviewKey: string;
  input: ReviewInput;
  source: ReviewSource;
  scope: NormalizedReviewScope;
  units: ReviewUnit[];
  excluded: ExcludedPath[];
  manifestDigest: string;
  totalUnits: number;
  rulesDigest: string;
  skillDigests: Record<string, string>;
  serverVersion: string;
}

export interface ReviewCheck {
  checkId: string;
  ruleId: string;
  text: string;
}

export interface UnitReviewArea {
  unitId: string;
  areas: string[];
  checks: ReviewCheck[];
  ruleIds: string[];
  rulesDigest: string;
  /** True when no special rule matched and generic checks were returned. */
  fallback?: boolean;
}

/** Input of the `get_code_review_area` tool. */
export interface GetCodeReviewAreaInput {
  source: ReviewSource;
  manifestDigest: string;
  unitIds: string[];
  rulesDigest: string;
  /** Raw range parameters used to rebuild the manifest before matching. */
  input?: ReviewInput;
  scope?: ReviewScope;
  cursor?: string;
}

/** Output of the `get_code_review_area` tool. */
export interface GetCodeReviewAreaOutput {
  areasByUnit: UnitReviewArea[];
  nextCursor?: string;
}

/** Input of the `export_code_review` tool. */
export interface ExportCodeReviewInput {
  workflowRunId: string;
  formats: ExportFormat[];
  /** Defaults to false. */
  allowPartial?: boolean;
}

export interface ExportedFile {
  format: ExportFormat;
  path: string;
  digest: string;
}

export interface FindingSummary {
  total: number;
  byPriority: Record<Priority, number>;
}

export interface CoverageUnit {
  unitId: string;
  kind: UnitKind;
  paths: string[];
  status: UnitStatus;
  reason?: string;
  reused?: boolean;
}

export interface Coverage {
  required: number;
  reviewed: number;
  reused: number;
  skipped: number;
  failed: number;
  pending: number;
  complete: boolean;
  /** Null when required is zero; never report 0/0 as 100%. */
  ratio: number | null;
  units: CoverageUnit[];
}

/** Output of the `export_code_review` tool. */
export interface ExportCodeReviewOutput {
  status: ExportStatus;
  workflowRunId: string;
  reportId: string;
  reviewKey: string;
  completion: Completion;
  outcome: Outcome;
  coverage: Coverage;
  findings: FindingSummary;
  files: ExportedFile[];
  gaps: ReviewGap[];
  generatedAt: string;
}

export interface Location {
  path: string;
  side: ChangeSide;
  startLine: number;
  endLine: number;
  snippet: string;
}

export interface Candidate {
  candidateId: string;
  unitId: string;
  category: Category;
  priority: Priority;
  title: string;
  trigger: string;
  impact: string;
  location: Location;
  evidence: Location[];
}

export interface NotApplicableCheck {
  checkId: string;
  reason: string;
}

export interface UnitResultError {
  code: string;
  message: string;
}

/** Result returned by one review-stage agent for one unit. */
export interface UnitResult {
  unitId: string;
  reviewKey: string;
  status: UnitResultStatus;
  checkedCheckIds: string[];
  notApplicable: NotApplicableCheck[];
  candidates: Candidate[];
  error?: UnitResultError;
}

/** Result returned by the verification stage for one candidate. */
export interface VerificationResult {
  candidateId: string;
  reviewKey: string;
  verdict: Verdict;
  reason: string;
  evidence: Location[];
  suggestedPriority?: Priority;
}

export interface ReviewAttempt {
  stage: ReviewStage;
  attempt: number;
  status: AttemptStatus;
  unitId?: string;
  candidateId?: string;
  error?: UnitResultError;
}

export interface ReviewGap {
  code: string;
  message: string;
  unitId?: string;
  candidateId?: string;
}

/**
 * Complete structured result of one Ultracode run. It is also the shape the
 * read-only run-store adapter recovers before export-time validation.
 */
export interface ReviewRunResult {
  formatVersion: 1;
  reviewKey: string;
  workflowRunId?: string;
  input: ReviewInput;
  manifest: ReviewManifest;
  areasByUnit: UnitReviewArea[];
  unitResults: UnitResult[];
  verificationResults: VerificationResult[];
  attempts: ReviewAttempt[];
  gaps: ReviewGap[];
  coverage: Coverage;
}

export interface ReportIdentity {
  formatVersion: 1;
  reportId: string;
  workflowRunId: string;
  reviewKey: string;
  packageVersion: string;
  rulesDigest: string;
  skillDigests: Record<string, string>;
}

export interface ReportFinding extends Candidate {
  verdict: Verdict;
  verification?: VerificationResult;
  originalPriority?: Priority;
  priorityChangeReason?: string;
}

export interface ReportModel {
  identity: ReportIdentity;
  source: ReviewSource;
  scope: NormalizedReviewScope;
  manifest: ReviewManifest;
  completion: Completion;
  outcome: Outcome;
  coverage: Coverage;
  confirmed: ReportFinding[];
  rejected: ReportFinding[];
  unresolved: ReportFinding[];
  gaps: ReviewGap[];
  attempts: ReviewAttempt[];
  generatedAt: string;
}

export interface LocationValidation {
  located: boolean;
  side: ChangeSide;
  startLine?: number;
  endLine?: number;
  digest?: string;
  note?: string;
}
