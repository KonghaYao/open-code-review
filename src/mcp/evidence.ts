// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
import { ReviewError } from '../domain/errors.js';
import type { Repository } from '../domain/interfaces.js';
import type { ChangeSide, Location, ReviewRunResult, ReviewSource } from '../domain/types.js';

export type FindingEvidenceRole = 'location' | 'evidence' | 'verification';

export interface FindingEvidenceFailure {
  candidateId: string;
  role: FindingEvidenceRole;
  /** Position inside the evidence array; null for the finding's own location. */
  index: number | null;
  path: string;
  side: ChangeSide;
  startLine: number;
  endLine: number;
  reason: 'unlocated' | 'invalid-location' | 'stale-source';
  note: string;
}

interface Rejection {
  reason: FindingEvidenceFailure['reason'];
  note: string;
}

/**
 * Revalidates every finding location against the fixed Git source before a
 * report is written. A location that cannot be resolved — a path missing from
 * the claimed side, binary content, a snippet the line range does not hold, or
 * a workspace that moved after the run — fails the whole export instead of
 * becoming a finding that no repository content backs.
 */
export async function verifyFindingEvidence(repository: Repository, result: ReviewRunResult): Promise<void> {
  const source = result.manifest.source;
  const failures: FindingEvidenceFailure[] = [];

  for (const unitResult of result.unitResults) {
    for (const candidate of unitResult.candidates) {
      await checkLocation(repository, source, candidate.candidateId, 'location', null, candidate.location, failures);
      for (const [index, location] of candidate.evidence.entries()) {
        await checkLocation(repository, source, candidate.candidateId, 'evidence', index, location, failures);
      }
    }
  }
  for (const verification of result.verificationResults) {
    for (const [index, location] of verification.evidence.entries()) {
      await checkLocation(
        repository,
        source,
        verification.candidateId,
        'verification',
        index,
        location,
        failures,
      );
    }
  }

  if (failures.length === 0) {
    return;
  }
  const [first] = failures;
  if (first === undefined) {
    return;
  }
  const where = `${first.candidateId} ${first.role} ${first.path} (${first.side} ${first.startLine}-${first.endLine})`;
  const message =
    failures.length === 1
      ? `finding ${where} does not resolve in the reviewed Git source: ${first.note}`
      : `${failures.length} finding locations do not resolve in the reviewed Git source; first is ${where}: ${first.note}`;
  throw new ReviewError('INVALID_FINDING', message, {
    details: { source: sourceIdentity(source), failures },
  });
}

async function checkLocation(
  repository: Repository,
  source: ReviewSource,
  candidateId: string,
  role: FindingEvidenceRole,
  index: number | null,
  location: Location,
  failures: FindingEvidenceFailure[],
): Promise<void> {
  const rejection = await rejectLocation(repository, source, location);
  if (rejection === undefined) {
    return;
  }
  failures.push({
    candidateId,
    role,
    index,
    path: location.path,
    side: location.side,
    startLine: location.startLine,
    endLine: location.endLine,
    ...rejection,
  });
}

/**
 * The repository owns snippet matching and relocation; this only classifies why
 * a location was refused so the caller gets a stable reason next to the note.
 */
async function rejectLocation(
  repository: Repository,
  source: ReviewSource,
  location: Location,
): Promise<Rejection | undefined> {
  try {
    const validation = await repository.verifyLocation(source, location);
    if (validation.located) {
      return undefined;
    }
    return { reason: 'unlocated', note: validation.note ?? 'location does not resolve on the claimed side' };
  } catch (error) {
    if (error instanceof ReviewError) {
      if (error.code === 'SOURCE_CHANGED') {
        return { reason: 'stale-source', note: error.message };
      }
      if (error.code === 'INVALID_FINDING' || error.code === 'INVALID_INPUT') {
        return { reason: 'invalid-location', note: error.message };
      }
    }
    throw error;
  }
}

function sourceIdentity(source: ReviewSource): Pick<ReviewSource, 'repoId' | 'mode' | 'baseSha' | 'headSha'> {
  return { repoId: source.repoId, mode: source.mode, baseSha: source.baseSha, headSha: source.headSha };
}
