// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
import type {
  ChangeSide,
  ExportCodeReviewInput,
  ExportCodeReviewOutput,
  Location,
  LocationValidation,
  PrepareCodeReviewInput,
  PrepareCodeReviewOutput,
  ReviewInput,
  ReviewManifest,
  ReviewRunResult,
  ReviewScope,
  ReviewSource,
  ReviewUnit,
  UnitReviewArea,
} from './types.js';

/** Git boundary: source resolution, unit manifests and evidence lookup. */
export interface Repository {
  /** Absolute repository root. Never serialized into tool responses. */
  readonly repoRoot: string;

  getRepoId(): Promise<string>;

  prepareCodeReview(input: PrepareCodeReviewInput): Promise<PrepareCodeReviewOutput>;

  /** Rebuilds the manifest from the fixed source and validates its digest. */
  rebuildManifest(source: ReviewSource, scope: ReviewScope | undefined, input?: ReviewInput): Promise<ReviewManifest>;

  /** Resolves a finding location against the exact Git side it claims. */
  verifyLocation(source: ReviewSource, location: Location): Promise<LocationValidation>;

  /** Returns the current workspace fingerprint, or undefined for fixed commits. */
  currentFingerprint(source: ReviewSource): Promise<string | undefined>;
}

export interface ReadFileRequest {
  source: ReviewSource;
  path: string;
  side: ChangeSide;
  maxBytes?: number;
}

export interface ReadFileResult {
  path: string;
  side: ChangeSide;
  text: string;
  digest: string;
  bytes: number;
  binary: boolean;
  truncated: boolean;
}

export interface ReadLinesRequest extends ReadFileRequest {
  startLine: number;
  endLine: number;
}

export interface ReadLinesResult {
  path: string;
  side: ChangeSide;
  startLine: number;
  endLine: number;
  text: string;
  digest: string;
}

export interface SearchMatch {
  path: string;
  line: number;
  text: string;
}

export interface SearchRequest {
  source: ReviewSource;
  side: ChangeSide;
  query: string;
  paths?: string[];
  maxResults?: number;
}

export interface SearchResult {
  matches: SearchMatch[];
  skippedFiles: string[];
}

/** Read-only access to the files of the resolved Git input. */
export interface Reader {
  readFile(request: ReadFileRequest): Promise<ReadFileResult>;
  readLines(request: ReadLinesRequest): Promise<ReadLinesResult>;
  search(request: SearchRequest): Promise<SearchResult>;
}

/** Internal rule matching. Rules are never exposed as a downloadable catalog. */
export interface RulesEngine {
  readonly rulesDigest: string;

  getAreas(source: ReviewSource, units: ReviewUnit[]): Promise<UnitReviewArea[]>;
}

export interface ReportBuildContext {
  workflowRunId: string;
  outputDir: string;
  packageVersion: string;
  generatedAt: string;
}

/** Validates a recovered run and writes JSON/Markdown reports atomically. */
export interface ReportBuilder {
  exportReport(input: ExportCodeReviewInput, result: ReviewRunResult, context: ReportBuildContext): Promise<ExportCodeReviewOutput>;
}

/**
 * Read-only adapter over Ultracode's run directory. It never writes to the
 * engine state or journal and never reconstructs a successful run from
 * incomplete journal fragments.
 */
export interface RunStateStore {
  readonly workflowRoot: string;

  load(workflowRunId: string): Promise<ReviewRunResult>;
}

export interface ReviewServices {
  repository: Repository;
  reader: Reader;
  rules: RulesEngine;
  reports: ReportBuilder;
  runs: RunStateStore;
}
