// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
import { ReviewError } from '../domain/errors.js';
import type {
  ExcludedPath,
  NormalizedReviewScope,
  ReviewInput,
  ReviewManifest,
  ReviewSource,
  ReviewUnit,
} from '../domain/types.js';
import { canonicalHash } from '../git/hash.js';

export interface ManifestIdentity {
  rulesDigest: string;
  skillDigests: Record<string, string>;
  serverVersion: string;
}

export interface CursorBinding {
  reviewKey: string;
  manifestDigest: string;
  query: string;
  total: number;
}

export interface ManifestParams {
  input: ReviewInput;
  source: ReviewSource;
  scope: NormalizedReviewScope;
  units: ReviewUnit[];
  excluded: ExcludedPath[];
  identity: ManifestIdentity;
}

interface SourceIdentity {
  repoId: string;
  mode: string;
  baseSha: string;
  headSha: string;
  mergeBaseSha: string;
  comparison: string;
  workspaceFingerprint: string;
}

/**
 * Only resolved identity contributes to a digest. Raw refs are deliberately
 * absent: a rebuild from `main` and from the exact SHA must agree once the
 * refs resolve to the same objects.
 */
export function sourceIdentity(source: ReviewSource): SourceIdentity {
  return {
    repoId: source.repoId,
    mode: source.mode,
    baseSha: source.baseSha,
    headSha: source.headSha,
    mergeBaseSha: source.mergeBaseSha ?? '',
    comparison: source.comparison,
    workspaceFingerprint: source.workspaceFingerprint ?? '',
  };
}

export function computeManifestDigest(
  source: ReviewSource,
  scope: NormalizedReviewScope,
  units: readonly ReviewUnit[],
  excluded: readonly ExcludedPath[],
): string {
  return canonicalHash({ source: sourceIdentity(source), scope, units, excluded });
}

export function computeReviewKey(params: {
  source: ReviewSource;
  scope: NormalizedReviewScope;
  manifestDigest: string;
  identity: ManifestIdentity;
}): string {
  return canonicalHash({
    source: sourceIdentity(params.source),
    scope: params.scope,
    manifestDigest: params.manifestDigest,
    rulesDigest: params.identity.rulesDigest,
    skillDigests: params.identity.skillDigests,
    serverVersion: params.identity.serverVersion,
  });
}

/** Binds a cursor to the exact request shape that produced its manifest. */
export function queryHash(input: ReviewInput, scope: NormalizedReviewScope): string {
  return canonicalHash({ input, scope });
}

export function buildManifest(params: ManifestParams): ReviewManifest {
  const manifestDigest = computeManifestDigest(params.source, params.scope, params.units, params.excluded);
  return {
    reviewKey: computeReviewKey({
      source: params.source,
      scope: params.scope,
      manifestDigest,
      identity: params.identity,
    }),
    input: params.input,
    source: params.source,
    scope: params.scope,
    units: params.units,
    excluded: params.excluded,
    manifestDigest,
    totalUnits: params.units.length,
    rulesDigest: params.identity.rulesDigest,
    skillDigests: params.identity.skillDigests,
    serverVersion: params.identity.serverVersion,
  };
}

interface CursorPayload {
  v: number;
  k: string;
  d: string;
  q: string;
  o: number;
}

export function encodeCursor(binding: CursorBinding, offset: number): string {
  const payload: CursorPayload = {
    v: 1,
    k: binding.reviewKey,
    d: binding.manifestDigest,
    q: binding.query,
    o: offset,
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/**
 * Returns the next offset. A cursor that belongs to another manifest, query or
 * review identity is rejected instead of silently mixing two manifests.
 */
export function decodeCursor(cursor: string | undefined, binding: CursorBinding): number {
  if (cursor === undefined || cursor === '') {
    return 0;
  }
  let payload: CursorPayload;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (parsed === null || typeof parsed !== 'object') {
      throw new Error('cursor payload is not an object');
    }
    payload = parsed as CursorPayload;
  } catch (error) {
    throw new ReviewError('INVALID_CURSOR', 'cursor is not a valid page cursor', { cause: error });
  }
  if (
    payload.v !== 1 ||
    typeof payload.k !== 'string' ||
    typeof payload.d !== 'string' ||
    typeof payload.q !== 'string' ||
    typeof payload.o !== 'number' ||
    !Number.isInteger(payload.o) ||
    payload.o < 0
  ) {
    throw new ReviewError('INVALID_CURSOR', 'cursor is not a valid page cursor');
  }
  if (payload.k !== binding.reviewKey || payload.d !== binding.manifestDigest || payload.q !== binding.query) {
    throw new ReviewError('INVALID_CURSOR', 'cursor does not belong to this review input and manifest');
  }
  if (payload.o > binding.total) {
    throw new ReviewError('INVALID_CURSOR', 'cursor points past the end of the manifest');
  }
  return payload.o;
}
