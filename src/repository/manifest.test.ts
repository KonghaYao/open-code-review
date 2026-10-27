// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
import { describe, expect, it } from 'vitest';

import { ReviewError } from '../domain/errors.js';
import type { ReviewInput, ReviewSource, ReviewUnit } from '../domain/types.js';
import {
  buildManifest,
  computeManifestDigest,
  computeReviewKey,
  decodeCursor,
  encodeCursor,
  queryHash,
  type ManifestIdentity,
} from './manifest.js';
import { normalizeScope } from './scope.js';

const IDENTITY: ManifestIdentity = {
  rulesDigest: 'sha256:rules',
  skillDigests: { 'skill-a': 'sha256:a' },
  serverVersion: '1.0.0',
};

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

function source(overrides: Partial<ReviewSource> = {}): ReviewSource {
  return {
    repoId: 'repo_test',
    mode: 'range',
    requestedRefs: { from: 'main', to: 'feature' },
    baseSha: SHA_A,
    headSha: SHA_B,
    mergeBaseSha: SHA_A,
    comparison: 'merge-base',
    ...overrides,
  };
}

function unit(overrides: Partial<ReviewUnit> = {}): ReviewUnit {
  return {
    unitId: 'u_1',
    kind: 'file',
    changeIds: ['ch_1'],
    paths: ['a.ts'],
    relatedPaths: [],
    side: 'head',
    startLine: 1,
    endLine: 2,
    slices: [],
    fullFile: false,
    ruleRefs: [],
    status: 'pending',
    ...overrides,
  };
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ReviewError);
    return (error as ReviewError).code;
  }
  throw new Error('expected the call to throw');
}

describe('manifest digests', () => {
  it('ignores the raw refs once the commits are resolved', () => {
    const scope = normalizeScope();
    const first = computeManifestDigest(source(), scope, [unit()], []);
    const second = computeManifestDigest(
      source({ requestedRefs: { from: 'origin/main', to: 'abc123' } }),
      scope,
      [unit()],
      [],
    );

    expect(first).toBe(second);
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it('changes when the resolved source changes', () => {
    const scope = normalizeScope();
    expect(computeManifestDigest(source(), scope, [], [])).not.toBe(
      computeManifestDigest(source({ headSha: 'c'.repeat(40) }), scope, [], []),
    );
  });

  it('changes when units, exclusions or scope change', () => {
    const scope = normalizeScope();
    const base = computeManifestDigest(source(), scope, [unit()], []);
    expect(computeManifestDigest(source(), scope, [unit({ unitId: 'u_2' })], [])).not.toBe(base);
    expect(computeManifestDigest(source(), scope, [unit()], [{ path: 'x.ts', reason: 'binary' }])).not.toBe(base);
    expect(computeManifestDigest(source(), normalizeScope({ includeTests: false }), [unit()], [])).not.toBe(base);
  });

  it('binds the review key to the rules, skills and server version', () => {
    const scope = normalizeScope();
    const manifestDigest = computeManifestDigest(source(), scope, [], []);
    const base = computeReviewKey({ source: source(), scope, manifestDigest, identity: IDENTITY });

    expect(computeReviewKey({ source: source(), scope, manifestDigest, identity: { ...IDENTITY, rulesDigest: 'sha256:other' } })).not.toBe(
      base,
    );
    expect(
      computeReviewKey({ source: source(), scope, manifestDigest, identity: { ...IDENTITY, skillDigests: {} } }),
    ).not.toBe(base);
    expect(
      computeReviewKey({ source: source(), scope, manifestDigest, identity: { ...IDENTITY, serverVersion: '2.0.0' } }),
    ).not.toBe(base);
  });
});

describe('queryHash', () => {
  const scope = normalizeScope();

  it('separates different inputs and scopes', () => {
    const range: ReviewInput = { mode: 'range', from: 'main', to: 'feature' };
    expect(queryHash(range, scope)).toBe(queryHash({ ...range }, scope));
    expect(queryHash(range, scope)).not.toBe(queryHash({ mode: 'commit', commit: 'abc' }, scope));
    expect(queryHash(range, scope)).not.toBe(queryHash(range, normalizeScope({ exclude: ['*.md'] })));
  });
});

describe('buildManifest', () => {
  it('reports the unit count and identity alongside the digest', () => {
    const manifest = buildManifest({
      input: { mode: 'range', from: 'main', to: 'feature' },
      source: source(),
      scope: normalizeScope(),
      units: [unit(), unit({ unitId: 'u_2' })],
      excluded: [],
      identity: IDENTITY,
    });

    expect(manifest.totalUnits).toBe(2);
    expect(manifest.rulesDigest).toBe('sha256:rules');
    expect(manifest.serverVersion).toBe('1.0.0');
    expect(manifest.manifestDigest).toBe(
      computeManifestDigest(manifest.source, manifest.scope, manifest.units, manifest.excluded),
    );
  });
});

describe('cursors', () => {
  const binding = { reviewKey: 'key', manifestDigest: 'sha256:digest', query: 'query', total: 3 };

  it('round-trips an offset', () => {
    expect(decodeCursor(encodeCursor(binding, 2), binding)).toBe(2);
    expect(decodeCursor(encodeCursor(binding, 3), binding)).toBe(3);
  });

  it('treats a missing cursor as the first page', () => {
    expect(decodeCursor(undefined, binding)).toBe(0);
    expect(decodeCursor('', binding)).toBe(0);
  });

  it('rejects a cursor from another manifest or query', () => {
    const encoded = encodeCursor(binding, 1);
    expect(codeOf(() => decodeCursor(encoded, { ...binding, reviewKey: 'other' }))).toBe('INVALID_CURSOR');
    expect(codeOf(() => decodeCursor(encoded, { ...binding, manifestDigest: 'other' }))).toBe('INVALID_CURSOR');
    expect(codeOf(() => decodeCursor(encoded, { ...binding, query: 'other' }))).toBe('INVALID_CURSOR');
  });

  it('rejects offsets past the end and malformed payloads', () => {
    expect(codeOf(() => decodeCursor(encodeCursor(binding, 4), binding))).toBe('INVALID_CURSOR');
    expect(codeOf(() => decodeCursor('not a cursor', binding))).toBe('INVALID_CURSOR');
    const wrongVersion = Buffer.from(JSON.stringify({ v: 2, k: 'key', d: 'sha256:digest', q: 'query', o: 0 })).toString(
      'base64url',
    );
    expect(codeOf(() => decodeCursor(wrongVersion, binding))).toBe('INVALID_CURSOR');
    const negative = Buffer.from(JSON.stringify({ v: 1, k: 'key', d: 'sha256:digest', q: 'query', o: -1 })).toString(
      'base64url',
    );
    expect(codeOf(() => decodeCursor(negative, binding))).toBe('INVALID_CURSOR');
  });
});
