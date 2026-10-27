// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
import { ReviewError } from '../domain/errors.js';
import {
  CATEGORIES,
  CHANGE_SIDES,
  COMPARISONS,
  EXCLUSION_REASONS,
  EXPORT_FORMATS,
  PRIORITIES,
  REVIEW_MODES,
  REVIEW_STAGES,
  RULE_SOURCES,
  UNIT_KINDS,
  UNIT_RESULT_STATUSES,
  UNIT_STATUSES,
  VERDICTS,
  ATTEMPT_STATUSES,
  type ExportCodeReviewInput,
  type ReviewRunResult,
} from '../domain/types.js';
import { isObjectId, normalizeRepoPath } from '../git/paths.js';

const DIRECT_REF_FIELDS = ['from', 'to', 'commit'] as const;

function invalid(message: string, details?: Record<string, unknown>): ReviewError {
  return new ReviewError('INVALID_INPUT', message, { details });
}

function invalidFinding(message: string, details?: Record<string, unknown>): ReviewError {
  return new ReviewError('INVALID_FINDING', message, { details });
}

function unsupported(message: string, details?: Record<string, unknown>): ReviewError {
  return new ReviewError('UNSUPPORTED_RUN_FORMAT', message, { details });
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalid(`${field} must be an object`, { field });
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.trim() === '')) {
    throw invalid(`${field} must be a non-empty string`, { field });
  }
  return value;
}

function requireInteger(value: unknown, field: string, minimum: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum) {
    throw invalid(`${field} must be an integer >= ${minimum}`, { field });
  }
  return value;
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') {
    throw invalid(`${field} must be a boolean`, { field });
  }
  return value;
}

function requireArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw invalid(`${field} must be an array`, { field });
  }
  return value;
}

function requireEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw invalid(`${field} must be one of ${allowed.join(', ')}`, { field });
  }
  return value as T;
}

function requireStringArray(value: unknown, field: string, allowEmptyEntries = false): void {
  const items = requireArray(value, field);
  for (const [index, item] of items.entries()) {
    requireString(item, `${field}[${index}]`, allowEmptyEntries);
  }
}

function requireRepoPath(value: unknown, field: string): string {
  const path = requireString(value, field);
  const normalized = normalizeRepoPath(path);
  if (normalized === '' || normalized !== path) {
    throw invalid(`${field} must be a normalized repository-relative path`, { field });
  }
  return normalized;
}

function requireOptionalString(value: unknown, field: string): void {
  if (value !== undefined) {
    requireString(value, field);
  }
}

function isAbsent(value: unknown): boolean {
  return value === undefined || value === null;
}

function validateReviewInput(value: unknown, field: string): void {
  const input = asRecord(value, field);
  const mode = requireEnum(input.mode, REVIEW_MODES, `${field}.mode`);
  switch (mode) {
    case 'range':
      requireString(input.from, `${field}.from`);
      requireString(input.to, `${field}.to`);
      if (!isAbsent(input.commit)) {
        throw invalid(`${field}.commit is not allowed in range mode`, { field });
      }
      return;
    case 'commit':
      requireString(input.commit, `${field}.commit`);
      if (!isAbsent(input.from) || !isAbsent(input.to)) {
        throw invalid(`${field} must not set from or to in commit mode`, { field });
      }
      return;
    case 'workspace':
      for (const key of DIRECT_REF_FIELDS) {
        if (!isAbsent(input[key])) {
          throw invalid(`${field}.${key} is not allowed in workspace mode`, { field });
        }
      }
      return;
    default: {
      const exhaustive: never = mode;
      throw invalid(`unsupported review mode: ${String(exhaustive)}`, { field });
    }
  }
}

function validateSource(value: unknown): void {
  const source = asRecord(value, 'manifest.source');
  requireString(source.repoId, 'manifest.source.repoId');
  const mode = requireEnum(source.mode, REVIEW_MODES, 'manifest.source.mode');
  requireObjectId(source.baseSha, 'manifest.source.baseSha');
  requireObjectId(source.headSha, 'manifest.source.headSha');
  if (source.requestedRefs !== undefined) {
    const refs = asRecord(source.requestedRefs, 'manifest.source.requestedRefs');
    for (const key of DIRECT_REF_FIELDS) {
      requireOptionalString(refs[key], `manifest.source.requestedRefs.${key}`);
    }
  }
  const comparison = requireEnum(source.comparison, COMPARISONS, 'manifest.source.comparison');
  if (source.mergeBaseSha !== undefined) {
    requireObjectId(source.mergeBaseSha, 'manifest.source.mergeBaseSha');
  }
  if (source.workspaceFingerprint !== undefined) {
    requireString(source.workspaceFingerprint, 'manifest.source.workspaceFingerprint');
  }

  switch (mode) {
    case 'range':
      if (comparison !== 'merge-base') {
        throw invalid('range sources must use the merge-base comparison', { field: 'manifest.source.comparison' });
      }
      if (source.mergeBaseSha !== source.baseSha) {
        throw invalid('range sources must use the merge base as baseSha', { field: 'manifest.source.baseSha' });
      }
      if (source.workspaceFingerprint !== undefined) {
        throw invalid('fixed sources must not carry a workspace fingerprint', { field: 'manifest.source' });
      }
      return;
    case 'commit':
      if (comparison !== 'first-parent') {
        throw invalid('commit sources must use the first-parent comparison', { field: 'manifest.source.comparison' });
      }
      if (source.workspaceFingerprint !== undefined) {
        throw invalid('fixed sources must not carry a workspace fingerprint', { field: 'manifest.source' });
      }
      return;
    case 'workspace':
      if (comparison !== 'workspace-vs-head') {
        throw invalid('workspace sources must use the workspace-vs-head comparison', {
          field: 'manifest.source.comparison',
        });
      }
      requireString(source.workspaceFingerprint, 'manifest.source.workspaceFingerprint');
      return;
    default: {
      const exhaustive: never = mode;
      throw invalid(`unsupported review mode: ${String(exhaustive)}`);
    }
  }
}

function requireObjectId(value: unknown, field: string): void {
  const id = requireString(value, field);
  if (!isObjectId(id)) {
    throw invalid(`${field} must be a Git object id`, { field });
  }
}

function validateScope(value: unknown): void {
  const scope = asRecord(value, 'manifest.scope');
  requireStringArray(scope.include, 'manifest.scope.include', true);
  requireStringArray(scope.exclude, 'manifest.scope.exclude', true);
  requireBoolean(scope.includeTests, 'manifest.scope.includeTests');
  requireBoolean(scope.includeDeleted, 'manifest.scope.includeDeleted');
}

function validateSlice(value: unknown, field: string): void {
  const slice = asRecord(value, field);
  requireInteger(slice.hunkIndex, `${field}.hunkIndex`, 0);
  const start = requireInteger(slice.start, `${field}.start`, 0);
  const end = requireInteger(slice.end, `${field}.end`, 0);
  if (end < start) {
    throw invalid(`${field}.end must not be before ${field}.start`, { field });
  }
}

function validateUnit(value: unknown, field: string): string {
  const unit = asRecord(value, field);
  const unitId = requireString(unit.unitId, `${field}.unitId`);
  requireEnum(unit.kind, UNIT_KINDS, `${field}.kind`);
  requireStringArray(unit.changeIds, `${field}.changeIds`);
  const paths = requireArray(unit.paths, `${field}.paths`);
  for (const [index, path] of paths.entries()) {
    requireRepoPath(path, `${field}.paths[${index}]`);
  }
  const related = requireArray(unit.relatedPaths, `${field}.relatedPaths`);
  for (const [index, path] of related.entries()) {
    requireRepoPath(path, `${field}.relatedPaths[${index}]`);
  }
  requireEnum(unit.side, CHANGE_SIDES, `${field}.side`);
  const startLine = requireInteger(unit.startLine, `${field}.startLine`, 0);
  const endLine = requireInteger(unit.endLine, `${field}.endLine`, 0);
  if (endLine < startLine) {
    throw invalid(`${field}.endLine must not be before startLine`, { field });
  }
  const slices = requireArray(unit.slices, `${field}.slices`);
  for (const [index, slice] of slices.entries()) {
    validateSlice(slice, `${field}.slices[${index}]`);
  }
  requireBoolean(unit.fullFile, `${field}.fullFile`);
  const refs = requireArray(unit.ruleRefs, `${field}.ruleRefs`);
  for (const [index, ref] of refs.entries()) {
    const ruleRef = asRecord(ref, `${field}.ruleRefs[${index}]`);
    requireEnum(ruleRef.source, RULE_SOURCES, `${field}.ruleRefs[${index}].source`);
    requireString(ruleRef.pattern, `${field}.ruleRefs[${index}].pattern`, true);
  }
  requireEnum(unit.status, UNIT_STATUSES, `${field}.status`);
  requireOptionalString(unit.reason, `${field}.reason`);
  return unitId;
}

function validateExcluded(value: unknown): void {
  const excluded = requireArray(value, 'manifest.excluded');
  for (const [index, item] of excluded.entries()) {
    const entry = asRecord(item, `manifest.excluded[${index}]`);
    requireRepoPath(entry.path, `manifest.excluded[${index}].path`);
    if (entry.side !== undefined) {
      requireEnum(entry.side, CHANGE_SIDES, `manifest.excluded[${index}].side`);
    }
    requireEnum(entry.reason, EXCLUSION_REASONS, `manifest.excluded[${index}].reason`);
    requireOptionalString(entry.source, `manifest.excluded[${index}].source`);
  }
}

function validateLocation(value: unknown, field: string): void {
  const location = asRecord(value, field);
  requireRepoPath(location.path, `${field}.path`);
  requireEnum(location.side, CHANGE_SIDES, `${field}.side`);
  const startLine = requireInteger(location.startLine, `${field}.startLine`, 1);
  const endLine = requireInteger(location.endLine, `${field}.endLine`, 1);
  if (endLine < startLine) {
    throw invalid(`${field}.endLine must not be before startLine`, { field });
  }
  if (typeof location.snippet !== 'string') {
    throw invalid(`${field}.snippet must be a string`, { field });
  }
}

function validateCandidate(value: unknown, field: string, unitId: string): string {
  const candidate = asRecord(value, field);
  const candidateId = requireString(candidate.candidateId, `${field}.candidateId`);
  if (candidate.unitId !== unitId) {
    throw invalidFinding(`${field}.unitId must match its unit result`, { field, unitId: candidate.unitId });
  }
  requireEnum(candidate.category, CATEGORIES, `${field}.category`);
  requireEnum(candidate.priority, PRIORITIES, `${field}.priority`);
  requireString(candidate.title, `${field}.title`);
  requireString(candidate.trigger, `${field}.trigger`);
  requireString(candidate.impact, `${field}.impact`);
  validateLocation(candidate.location, `${field}.location`);
  const evidence = requireArray(candidate.evidence, `${field}.evidence`);
  for (const [index, item] of evidence.entries()) {
    validateLocation(item, `${field}.evidence[${index}]`);
  }
  return candidateId;
}

function validateUnitResult(value: unknown, index: number, reviewKey: string): string {
  const field = `unitResults[${index}]`;
  const result = asRecord(value, field);
  const unitId = requireString(result.unitId, `${field}.unitId`);
  if (result.reviewKey !== reviewKey) {
    throw invalid(`${field}.reviewKey does not match the run reviewKey`, { field });
  }
  requireEnum(result.status, UNIT_RESULT_STATUSES, `${field}.status`);
  requireStringArray(result.checkedCheckIds, `${field}.checkedCheckIds`);
  const notApplicable = requireArray(result.notApplicable, `${field}.notApplicable`);
  for (const [checkIndex, item] of notApplicable.entries()) {
    const entry = asRecord(item, `${field}.notApplicable[${checkIndex}]`);
    requireString(entry.checkId, `${field}.notApplicable[${checkIndex}].checkId`);
    requireString(entry.reason, `${field}.notApplicable[${checkIndex}].reason`, true);
  }
  if (result.error !== undefined) {
    const error = asRecord(result.error, `${field}.error`);
    requireString(error.code, `${field}.error.code`);
    requireString(error.message, `${field}.error.message`, true);
  }
  const candidates = requireArray(result.candidates, `${field}.candidates`);
  for (const [candidateIndex, candidate] of candidates.entries()) {
    validateCandidate(candidate, `${field}.candidates[${candidateIndex}]`, unitId);
  }
  return unitId;
}

function validateVerification(value: unknown, index: number, reviewKey: string): void {
  const field = `verificationResults[${index}]`;
  const verification = asRecord(value, field);
  requireString(verification.candidateId, `${field}.candidateId`);
  if (verification.reviewKey !== reviewKey) {
    throw invalid(`${field}.reviewKey does not match the run reviewKey`, { field });
  }
  requireEnum(verification.verdict, VERDICTS, `${field}.verdict`);
  if (typeof verification.reason !== 'string') {
    throw invalid(`${field}.reason must be a string`, { field });
  }
  const evidence = requireArray(verification.evidence, `${field}.evidence`);
  for (const [evidenceIndex, item] of evidence.entries()) {
    validateLocation(item, `${field}.evidence[${evidenceIndex}]`);
  }
  if (verification.suggestedPriority !== undefined) {
    requireEnum(verification.suggestedPriority, PRIORITIES, `${field}.suggestedPriority`);
  }
}

function validateAttempt(value: unknown, index: number): void {
  const field = `attempts[${index}]`;
  const attempt = asRecord(value, field);
  requireEnum(attempt.stage, REVIEW_STAGES, `${field}.stage`);
  requireInteger(attempt.attempt, `${field}.attempt`, 1);
  requireEnum(attempt.status, ATTEMPT_STATUSES, `${field}.status`);
  requireOptionalString(attempt.unitId, `${field}.unitId`);
  requireOptionalString(attempt.candidateId, `${field}.candidateId`);
  if (attempt.error !== undefined) {
    const error = asRecord(attempt.error, `${field}.error`);
    requireString(error.code, `${field}.error.code`);
    requireString(error.message, `${field}.error.message`, true);
  }
}

function validateGap(value: unknown, index: number): void {
  const field = `gaps[${index}]`;
  const gap = asRecord(value, field);
  requireString(gap.code, `${field}.code`);
  requireString(gap.message, `${field}.message`);
  requireOptionalString(gap.unitId, `${field}.unitId`);
  requireOptionalString(gap.candidateId, `${field}.candidateId`);
}

function validateCoverageShape(value: unknown): void {
  const coverage = asRecord(value, 'coverage');
  for (const key of ['required', 'reviewed', 'reused', 'skipped', 'failed', 'pending'] as const) {
    requireInteger(coverage[key], `coverage.${key}`, 0);
  }
  requireBoolean(coverage.complete, 'coverage.complete');
  if (coverage.ratio !== null && coverage.ratio !== undefined) {
    if (typeof coverage.ratio !== 'number' || !Number.isFinite(coverage.ratio) || coverage.ratio < 0 || coverage.ratio > 1) {
      throw invalid('coverage.ratio must be null or a number between 0 and 1', { field: 'coverage.ratio' });
    }
  }
  const units = requireArray(coverage.units, 'coverage.units');
  for (const [index, item] of units.entries()) {
    const field = `coverage.units[${index}]`;
    const unit = asRecord(item, field);
    requireString(unit.unitId, `${field}.unitId`);
    requireEnum(unit.kind, UNIT_KINDS, `${field}.kind`);
    requireStringArray(unit.paths, `${field}.paths`, true);
    requireEnum(unit.status, UNIT_STATUSES, `${field}.status`);
    requireOptionalString(unit.reason, `${field}.reason`);
    if (unit.reused !== undefined) {
      requireBoolean(unit.reused, `${field}.reused`);
    }
  }
}

function validateAreas(value: unknown, unitIds: ReadonlySet<string>): void {
  const areas = requireArray(value, 'areasByUnit');
  const seen = new Set<string>();
  for (const [index, item] of areas.entries()) {
    const field = `areasByUnit[${index}]`;
    const area = asRecord(item, field);
    const unitId = requireString(area.unitId, `${field}.unitId`);
    if (!unitIds.has(unitId)) {
      throw invalid(`${field}.unitId is not part of the manifest`, { field, unitId });
    }
    if (seen.has(unitId)) {
      throw invalid(`duplicate review area for unit ${unitId}`, { unitId });
    }
    seen.add(unitId);
    requireStringArray(area.areas, `${field}.areas`, true);
    const checks = requireArray(area.checks, `${field}.checks`);
    const checkIds = new Set<string>();
    for (const [checkIndex, check] of checks.entries()) {
      const checkField = `${field}.checks[${checkIndex}]`;
      const record = asRecord(check, checkField);
      const checkId = requireString(record.checkId, `${checkField}.checkId`);
      if (checkIds.has(checkId)) {
        throw invalid(`duplicate checkId ${checkId} in unit ${unitId}`, { checkId, unitId });
      }
      checkIds.add(checkId);
      requireString(record.ruleId, `${checkField}.ruleId`);
      if (typeof record.text !== 'string') {
        throw invalid(`${checkField}.text must be a string`, { field: checkField });
      }
    }
    requireStringArray(area.ruleIds, `${field}.ruleIds`);
    requireString(area.rulesDigest, `${field}.rulesDigest`);
    if (area.fallback !== undefined) {
      requireBoolean(area.fallback, `${field}.fallback`);
    }
  }
}

function validateManifest(result: Record<string, unknown>): string {
  const manifest = asRecord(result.manifest, 'manifest');
  const reviewKey = requireString(manifest.reviewKey, 'manifest.reviewKey');
  if (reviewKey !== result.reviewKey) {
    throw invalid('manifest.reviewKey does not match the run reviewKey', { field: 'manifest.reviewKey' });
  }
  validateReviewInput(manifest.input, 'manifest.input');
  validateSource(manifest.source);
  validateScope(manifest.scope);

  const units = requireArray(manifest.units, 'manifest.units');
  const unitIds = new Set<string>();
  for (const [index, unit] of units.entries()) {
    const unitId = validateUnit(unit, `manifest.units[${index}]`);
    if (unitIds.has(unitId)) {
      throw invalid(`duplicate unitId ${unitId} in the manifest`, { unitId });
    }
    unitIds.add(unitId);
  }

  validateExcluded(manifest.excluded);
  requireString(manifest.manifestDigest, 'manifest.manifestDigest');
  const totalUnits = requireInteger(manifest.totalUnits, 'manifest.totalUnits', 0);
  if (totalUnits !== units.length) {
    throw invalid('manifest.totalUnits must equal the number of manifest units', {
      field: 'manifest.totalUnits',
      totalUnits,
      units: units.length,
    });
  }
  requireString(manifest.rulesDigest, 'manifest.rulesDigest');
  const skillDigests = asRecord(manifest.skillDigests, 'manifest.skillDigests');
  for (const [name, digest] of Object.entries(skillDigests)) {
    requireString(name, 'manifest.skillDigests key');
    requireString(digest, `manifest.skillDigests.${name}`);
  }
  requireString(manifest.serverVersion, 'manifest.serverVersion');
  return reviewKey;
}

/**
 * Runtime validation matching the published contract. The exporter never trusts
 * agent-provided counters or percentages; this only rejects malformed data
 * before coverage is recomputed.
 */
export function validateReviewRunResult(
  result: ReviewRunResult,
  options: { expectedWorkflowRunId?: string } = {},
): void {
  const run = asRecord(result, 'result');
  if (run.formatVersion !== 1) {
    throw unsupported('review result formatVersion must be 1', { formatVersion: run.formatVersion });
  }
  const reviewKey = requireString(run.reviewKey, 'reviewKey');
  if (run.workflowRunId !== undefined) {
    const workflowRunId = requireString(run.workflowRunId, 'workflowRunId');
    if (options.expectedWorkflowRunId !== undefined && workflowRunId !== options.expectedWorkflowRunId) {
      throw invalid('review result belongs to another workflow run', {
        expectedWorkflowRunId: options.expectedWorkflowRunId,
        workflowRunId,
      });
    }
  }
  validateReviewInput(run.input, 'input');
  validateManifest(run);

  const manifest = asRecord(run.manifest, 'manifest');
  const unitIds = new Set(
    requireArray(manifest.units, 'manifest.units').map((unit, index) =>
      requireString(asRecord(unit, `manifest.units[${index}]`).unitId, `manifest.units[${index}].unitId`),
    ),
  );

  validateAreas(run.areasByUnit, unitIds);

  const unitResults = requireArray(run.unitResults, 'unitResults');
  const resultUnitIds = new Set<string>();
  const candidateIds = new Set<string>();
  for (const [index, item] of unitResults.entries()) {
    const unitId = validateUnitResult(item, index, reviewKey);
    if (resultUnitIds.has(unitId)) {
      throw invalid(`duplicate unit result for unit ${unitId}`, { unitId });
    }
    resultUnitIds.add(unitId);
    const record = asRecord(item, `unitResults[${index}]`);
    const candidates = requireArray(record.candidates, `unitResults[${index}].candidates`);
    for (const [candidateIndex, candidate] of candidates.entries()) {
      const candidateId = requireString(
        asRecord(candidate, `unitResults[${index}].candidates[${candidateIndex}]`).candidateId,
        `unitResults[${index}].candidates[${candidateIndex}].candidateId`,
      );
      if (candidateIds.has(candidateId)) {
        throw invalidFinding(`duplicate candidateId ${candidateId}`, { candidateId });
      }
      candidateIds.add(candidateId);
    }
  }

  const verifications = requireArray(run.verificationResults, 'verificationResults');
  for (const [index, verification] of verifications.entries()) {
    validateVerification(verification, index, reviewKey);
  }

  const attempts = requireArray(run.attempts, 'attempts');
  for (const [index, attempt] of attempts.entries()) {
    validateAttempt(attempt, index);
  }

  const gaps = requireArray(run.gaps, 'gaps');
  for (const [index, gap] of gaps.entries()) {
    validateGap(gap, index);
  }

  validateCoverageShape(run.coverage);
}

/** Validates the export request before any filesystem work. */
export function validateExportInput(input: ExportCodeReviewInput): void {
  const request = asRecord(input, 'input');
  requireString(request.workflowRunId, 'workflowRunId');
  const formats = requireArray(request.formats, 'formats');
  if (formats.length === 0) {
    throw invalid('formats must contain at least one export format', { field: 'formats' });
  }
  const seen = new Set<string>();
  for (const [index, format] of formats.entries()) {
    const value = requireEnum(format, EXPORT_FORMATS, `formats[${index}]`);
    if (seen.has(value)) {
      throw invalid(`duplicate export format ${value}`, { format: value });
    }
    seen.add(value);
  }
  if (request.allowPartial !== undefined) {
    requireBoolean(request.allowPartial, 'allowPartial');
  }
}
