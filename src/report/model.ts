// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
import type {
  Candidate,
  Completion,
  Coverage,
  CoverageUnit,
  FindingSummary,
  Location,
  Outcome,
  Priority,
  ReportFinding,
  ReportModel,
  ReviewAttempt,
  ReviewGap,
  ReviewRunResult,
  ReviewStage,
  UnitKind,
  UnitStatus,
  VerificationResult,
} from '../domain/types.js';
import { canonicalHash, canonicalJson, shortHash } from '../git/hash.js';

const PRIORITY_ORDER: Record<Priority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
const STAGE_ORDER: Record<ReviewStage, number> = { review: 0, verify: 1, aggregate: 2 };

export interface RunEvaluation {
  coverage: Coverage;
  completion: Completion;
  outcome: Outcome;
  gaps: ReviewGap[];
  findings: FindingSummary;
  confirmed: ReportFinding[];
  rejected: ReportFinding[];
  unresolved: ReportFinding[];
}

interface CandidateEntry {
  candidate: Candidate;
}

/**
 * Recomputes coverage and completion from the manifest and stage results. The
 * run's own coverage counters are deliberately ignored: only the manifest is
 * the denominator, and a unit counts as reviewed only when every check handed
 * out for it has a record.
 */
export function evaluateRun(result: ReviewRunResult): RunEvaluation {
  const gaps: ReviewGap[] = result.gaps.map((gap) => copyGap(gap));
  const seenGapKeys = new Set(gaps.map(gapKey));
  const addGap = (gap: ReviewGap): void => {
    const key = gapKey(gap);
    if (!seenGapKeys.has(key)) {
      seenGapKeys.add(key);
      gaps.push(gap);
    }
  };

  const resultByUnit = new Map(result.unitResults.map((item) => [item.unitId, item]));
  const areaByUnit = new Map(result.areasByUnit.map((area) => [area.unitId, area]));
  const required = result.manifest.units.length;
  const coverageUnits: CoverageUnit[] = [];
  let reviewed = 0;
  let skipped = 0;
  let failed = 0;

  for (const unit of result.manifest.units) {
    const unitResult = resultByUnit.get(unit.unitId);
    const label = unitLabel(unit.paths);
    let status: UnitStatus = 'pending';
    let reason: string | undefined;

    if (unitResult === undefined) {
      addGap({
        code: 'UNIT_PENDING',
        message: `unit ${unit.unitId} (${label}) is still pending`,
        unitId: unit.unitId,
      });
    } else {
      switch (unitResult.status) {
        case 'reviewed':
          status = reviewedUnitStatus(unit.unitId, unitResult, areaByUnit.get(unit.unitId), addGap);
          if (status === 'pending') {
            reason = unitReason(unit.unitId, unitResult, areaByUnit.get(unit.unitId));
          }
          if (status === 'reviewed') {
            reviewed += 1;
          }
          break;
        case 'failed':
          status = 'failed';
          failed += 1;
          reason = unitResult.error?.message ?? 'failed without an error';
          addGap({
            code: 'UNIT_FAILED',
            message: `unit ${unit.unitId} (${label}) failed: ${reason}`,
            unitId: unit.unitId,
          });
          break;
        case 'skipped':
          status = 'skipped';
          skipped += 1;
          reason = unitResult.error?.message ?? 'skipped without a reason';
          addGap({
            code: 'UNIT_SKIPPED',
            message: `unit ${unit.unitId} (${label}) was skipped: ${reason}`,
            unitId: unit.unitId,
          });
          break;
        default: {
          const exhaustive: never = unitResult.status;
          throw new Error(`unexpected unit status: ${String(exhaustive)}`);
        }
      }
    }

    coverageUnits.push({
      unitId: unit.unitId,
      kind: unit.kind as UnitKind,
      paths: [...unit.paths],
      status,
      ...(reason === undefined ? {} : { reason }),
      reused: false,
    });
  }

  const coverage: Coverage = {
    required,
    reviewed,
    reused: 0,
    skipped,
    failed,
    pending: Math.max(0, required - reviewed - skipped - failed),
    complete: reviewed === required,
    ratio: required === 0 ? null : reviewed / required,
    units: coverageUnits,
  };

  const knownUnitIds = new Set(result.manifest.units.map((unit) => unit.unitId));
  const candidates: CandidateEntry[] = [];
  const candidateIds = new Set<string>();
  for (const unitResult of result.unitResults) {
    if (!knownUnitIds.has(unitResult.unitId)) {
      addGap({
        code: 'UNKNOWN_UNIT_RESULT',
        message: `unit result ${unitResult.unitId} is not part of the manifest`,
        unitId: unitResult.unitId,
      });
    }
    for (const candidate of unitResult.candidates) {
      if (candidateIds.has(candidate.candidateId)) {
        continue;
      }
      candidateIds.add(candidate.candidateId);
      candidates.push({ candidate });
      if (!knownUnitIds.has(candidate.unitId)) {
        addGap({
          code: 'UNKNOWN_CANDIDATE_UNIT',
          message: `candidate ${candidate.candidateId} refers to unknown unit ${candidate.unitId}`,
          unitId: candidate.unitId,
          candidateId: candidate.candidateId,
        });
      }
    }
  }

  const verifications = groupVerifications(result.verificationResults);
  for (const candidateId of verifications.keys()) {
    if (!candidateIds.has(candidateId)) {
      addGap({
        code: 'UNKNOWN_VERIFICATION',
        message: `verification refers to unknown candidate ${candidateId}`,
        candidateId,
      });
    }
  }

  const confirmed: ReportFinding[] = [];
  const rejected: ReportFinding[] = [];
  const unresolved: ReportFinding[] = [];
  for (const { candidate } of candidates) {
    const group = verifications.get(candidate.candidateId);
    let verification: VerificationResult | undefined;
    let verdict: ReportFinding['verdict'] = 'unresolved';
    if (group === undefined || group.length === 0) {
      addGap({
        code: 'VERIFICATION_MISSING',
        message: `candidate ${candidate.candidateId} has no verification verdict`,
        unitId: candidate.unitId,
        candidateId: candidate.candidateId,
      });
    } else {
      const distinct = distinctVerifications(group);
      if (distinct.length > 1) {
        addGap({
          code: 'CONFLICTING_VERIFICATION',
          message: `candidate ${candidate.candidateId} has conflicting verification results`,
          unitId: candidate.unitId,
          candidateId: candidate.candidateId,
        });
      } else {
        verification = distinct[0];
        verdict = verification?.verdict ?? 'unresolved';
      }
    }
    const finding = toReportFinding(candidate, verdict, verification);
    if (verdict === 'confirmed') {
      confirmed.push(finding);
    } else if (verdict === 'rejected') {
      rejected.push(finding);
    } else {
      unresolved.push(finding);
    }
  }

  confirmed.sort(compareFindings);
  rejected.sort(compareFindings);
  unresolved.sort(compareFindings);

  const partial = gaps.length > 0 || unresolved.length > 0 || (required > 0 && !coverage.complete);
  const completion: Completion = partial ? 'partial' : 'complete';
  const outcome: Outcome = partial
    ? 'inconclusive'
    : confirmed.length > 0
      ? 'findings'
      : required === 0
        ? 'noChanges'
        : 'clean';

  return {
    coverage,
    completion,
    outcome,
    gaps,
    findings: summarizeFindings(confirmed),
    confirmed,
    rejected,
    unresolved,
  };
}

/** Builds the single validated model that both output formats render from. */
export function buildReportModel(args: {
  result: ReviewRunResult;
  workflowRunId: string;
  packageVersion: string;
  generatedAt: string;
  evaluation?: RunEvaluation;
}): ReportModel {
  const evaluation = args.evaluation ?? evaluateRun(args.result);
  const manifest = args.result.manifest;
  return {
    identity: {
      formatVersion: 1,
      reportId: '',
      workflowRunId: args.workflowRunId,
      reviewKey: args.result.reviewKey,
      packageVersion: args.packageVersion,
      rulesDigest: manifest.rulesDigest,
      skillDigests: sortedRecord(manifest.skillDigests),
    },
    source: manifest.source,
    scope: manifest.scope,
    manifest,
    completion: evaluation.completion,
    outcome: evaluation.outcome,
    coverage: evaluation.coverage,
    confirmed: evaluation.confirmed,
    rejected: evaluation.rejected,
    unresolved: evaluation.unresolved,
    gaps: evaluation.gaps,
    attempts: args.result.attempts.map(copyAttempt).sort(compareAttempts),
    generatedAt: args.generatedAt,
  };
}

/**
 * Binds the report id to the run id and a digest of the effective content.
 * `generatedAt` is part of the content, so a new timestamp produces a new
 * report instead of silently rewriting an existing one.
 */
export function assignReportId(model: ReportModel): string {
  const contentDigest = canonicalHash({ ...model, identity: { ...model.identity, reportId: '' } });
  const reportId = `rpt_${shortHash(model.identity.workflowRunId, contentDigest)}`;
  model.identity.reportId = reportId;
  return reportId;
}

function reviewedUnitStatus(
  unitId: string,
  unitResult: ReviewRunResult['unitResults'][number],
  area: ReviewRunResult['areasByUnit'][number] | undefined,
  addGap: (gap: ReviewGap) => void,
): UnitStatus {
  if (area === undefined) {
    addGap({
      code: 'AREA_MISSING',
      message: `unit ${unitId} has no review area; required checks cannot be verified`,
      unitId,
    });
    return 'pending';
  }
  const missing = missingChecks(unitResult, area);
  if (missing.length > 0) {
    addGap({
      code: 'CHECK_MISSING',
      message: `unit ${unitId} is missing check records: ${missing.join(', ')}`,
      unitId,
    });
    return 'pending';
  }
  return 'reviewed';
}

function unitReason(
  unitId: string,
  unitResult: ReviewRunResult['unitResults'][number],
  area: ReviewRunResult['areasByUnit'][number] | undefined,
): string {
  if (area === undefined) {
    return 'no review area recorded';
  }
  return `missing check records: ${missingChecks(unitResult, area).join(', ')}`;
}

function missingChecks(
  unitResult: ReviewRunResult['unitResults'][number],
  area: ReviewRunResult['areasByUnit'][number],
): string[] {
  const checked = new Set(unitResult.checkedCheckIds);
  const notApplicable = new Set(unitResult.notApplicable.map((entry) => entry.checkId));
  return area.checks
    .map((check) => check.checkId)
    .filter((checkId) => !checked.has(checkId) && !notApplicable.has(checkId));
}

function groupVerifications(results: VerificationResult[]): Map<string, VerificationResult[]> {
  const grouped = new Map<string, VerificationResult[]>();
  for (const verification of results) {
    const existing = grouped.get(verification.candidateId);
    if (existing === undefined) {
      grouped.set(verification.candidateId, [verification]);
    } else {
      existing.push(verification);
    }
  }
  return grouped;
}

function distinctVerifications(group: VerificationResult[]): VerificationResult[] {
  const distinct: VerificationResult[] = [];
  const seen = new Set<string>();
  for (const verification of group) {
    const key = canonicalJson(copyVerification(verification));
    if (!seen.has(key)) {
      seen.add(key);
      distinct.push(verification);
    }
  }
  return distinct;
}

function toReportFinding(
  candidate: Candidate,
  verdict: ReportFinding['verdict'],
  verification: VerificationResult | undefined,
): ReportFinding {
  const suggested = verdict === 'confirmed' ? verification?.suggestedPriority : undefined;
  const changed = suggested !== undefined && suggested !== candidate.priority;
  return {
    candidateId: candidate.candidateId,
    unitId: candidate.unitId,
    category: candidate.category,
    priority: changed ? suggested : candidate.priority,
    title: candidate.title,
    trigger: candidate.trigger,
    impact: candidate.impact,
    location: copyLocation(candidate.location),
    evidence: candidate.evidence.map(copyLocation),
    verdict,
    ...(verification === undefined ? {} : { verification: copyVerification(verification) }),
    ...(changed
      ? {
          originalPriority: candidate.priority,
          priorityChangeReason:
            verification?.reason.trim() === ''
              ? `verification suggested ${suggested}`
              : (verification?.reason.trim() ?? `verification suggested ${suggested}`),
        }
      : {}),
  };
}

function summarizeFindings(confirmed: ReportFinding[]): FindingSummary {
  const byPriority: Record<Priority, number> = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const finding of confirmed) {
    byPriority[finding.priority] += 1;
  }
  return { total: confirmed.length, byPriority };
}

function copyLocation(location: Location): Location {
  return {
    path: location.path,
    side: location.side,
    startLine: location.startLine,
    endLine: location.endLine,
    snippet: location.snippet,
  };
}

function copyVerification(verification: VerificationResult): VerificationResult {
  return {
    candidateId: verification.candidateId,
    reviewKey: verification.reviewKey,
    verdict: verification.verdict,
    reason: verification.reason,
    evidence: verification.evidence.map(copyLocation),
    ...(verification.suggestedPriority === undefined
      ? {}
      : { suggestedPriority: verification.suggestedPriority }),
  };
}

function copyAttempt(attempt: ReviewAttempt): ReviewAttempt {
  return {
    stage: attempt.stage,
    attempt: attempt.attempt,
    status: attempt.status,
    ...(attempt.unitId === undefined ? {} : { unitId: attempt.unitId }),
    ...(attempt.candidateId === undefined ? {} : { candidateId: attempt.candidateId }),
    ...(attempt.error === undefined ? {} : { error: { code: attempt.error.code, message: attempt.error.message } }),
  };
}

function copyGap(gap: ReviewGap): ReviewGap {
  return {
    code: gap.code,
    message: gap.message,
    ...(gap.unitId === undefined ? {} : { unitId: gap.unitId }),
    ...(gap.candidateId === undefined ? {} : { candidateId: gap.candidateId }),
  };
}

function gapKey(gap: ReviewGap): string {
  return `${gap.code}\0${gap.unitId ?? ''}\0${gap.candidateId ?? ''}`;
}

function unitLabel(paths: readonly string[]): string {
  const first = paths[0];
  if (first === undefined) {
    return 'cross-file';
  }
  return paths.length === 1 ? first : `${first} (+${String(paths.length - 1)} files)`;
}

function compareFindings(left: ReportFinding, right: ReportFinding): number {
  return (
    PRIORITY_ORDER[left.priority] - PRIORITY_ORDER[right.priority] ||
    compareStrings(left.location.path, right.location.path) ||
    left.location.startLine - right.location.startLine ||
    left.location.endLine - right.location.endLine ||
    compareStrings(left.candidateId, right.candidateId)
  );
}

function compareAttempts(left: ReviewAttempt, right: ReviewAttempt): number {
  return (
    STAGE_ORDER[left.stage] - STAGE_ORDER[right.stage] ||
    left.attempt - right.attempt ||
    compareStrings(left.unitId ?? '', right.unitId ?? '') ||
    compareStrings(left.candidateId ?? '', right.candidateId ?? '')
  );
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedRecord(record: Record<string, string>): Record<string, string> {
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(record).sort(compareStrings)) {
    sorted[key] = record[key] as string;
  }
  return sorted;
}
