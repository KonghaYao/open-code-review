// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
import { Buffer } from 'node:buffer';

import { ReviewError } from '../domain/errors.js';
import type { Comparison, ReviewInput, ReviewMode, ReviewSource } from '../domain/types.js';
import { EMPTY_TREE_SHA, type GitObjects } from '../git/objects.js';
import { isObjectId } from '../git/paths.js';
import {
  collectFixedChanges,
  collectWorkspaceChanges,
  type ChangeLimits,
  type ChangeRecord,
} from './changes.js';
import { inspectWorkspace } from './workspace.js';

const MODE_COMPARISON: Record<ReviewMode, Comparison> = {
  range: 'merge-base',
  commit: 'first-parent',
  workspace: 'workspace-vs-head',
};

export interface ResolvedReview {
  input: ReviewInput;
  source: ReviewSource;
  changes: ChangeRecord[];
}

/** Validates one input mode and drops refs that belong to another mode. */
export function normalizeReviewInput(input: ReviewInput): ReviewInput {
  if (input === null || typeof input !== 'object') {
    throw new ReviewError('INVALID_INPUT', 'input is required');
  }
  const from = trimRef(input.from);
  const to = trimRef(input.to);
  const commit = trimRef(input.commit);
  for (const ref of [from, to, commit]) {
    validateRef(ref);
  }

  switch (input.mode) {
    case 'range':
      if (from === '' || to === '') {
        throw new ReviewError('INVALID_INPUT', 'range input requires from and to');
      }
      if (commit !== '') {
        throw new ReviewError('INVALID_INPUT', 'range input must not set commit');
      }
      return { mode: 'range', from, to };
    case 'commit':
      if (commit === '') {
        throw new ReviewError('INVALID_INPUT', 'commit input requires commit');
      }
      if (from !== '' || to !== '') {
        throw new ReviewError('INVALID_INPUT', 'commit input must not set from or to');
      }
      return { mode: 'commit', commit };
    case 'workspace':
      if (from !== '' || to !== '' || commit !== '') {
        throw new ReviewError('INVALID_INPUT', 'workspace input must not set refs');
      }
      return { mode: 'workspace' };
    default: {
      const exhaustive: never = input.mode;
      throw new ReviewError('INVALID_INPUT', `unknown input mode ${JSON.stringify(String(exhaustive))}`);
    }
  }
}

/** Resolves refs once and freezes the resulting commit ids into a source. */
export async function resolveReviewSource(
  git: GitObjects,
  repoId: string,
  input: ReviewInput,
  limits: ChangeLimits,
): Promise<ResolvedReview> {
  switch (input.mode) {
    case 'range': {
      const from = await git.resolveCommit(input.from ?? '');
      const to = await git.resolveCommit(input.to ?? '');
      const mergeBase = await git.mergeBase(from, to);
      const changes = await collectFixedChanges(git, mergeBase, to, 'range', limits);
      return {
        input,
        changes,
        source: {
          repoId,
          mode: 'range',
          requestedRefs: { from: input.from, to: input.to },
          baseSha: mergeBase,
          headSha: to,
          mergeBaseSha: mergeBase,
          comparison: 'merge-base',
        },
      };
    }
    case 'commit': {
      const head = await git.resolveCommit(input.commit ?? '');
      const parent = await git.firstParent(head);
      // A root commit compares against git's empty tree.
      const base = parent === '' ? EMPTY_TREE_SHA : parent;
      const changes = await collectFixedChanges(git, base, head, 'commit', limits);
      return {
        input,
        changes,
        source: {
          repoId,
          mode: 'commit',
          requestedRefs: { commit: input.commit },
          baseSha: base,
          headSha: head,
          comparison: 'first-parent',
        },
      };
    }
    case 'workspace': {
      const before = await inspectWorkspace(git, limits.maxFileBytes);
      const changes = await collectWorkspaceChanges(git, before, limits);
      const after = await inspectWorkspace(git, limits.maxFileBytes);
      if (before.fingerprint !== after.fingerprint) {
        throw new ReviewError('SOURCE_CHANGED', 'workspace changed while the review input was being prepared');
      }
      return {
        input,
        changes,
        source: {
          repoId,
          mode: 'workspace',
          baseSha: before.headSha,
          headSha: before.headSha,
          comparison: 'workspace-vs-head',
          workspaceFingerprint: before.fingerprint,
        },
      };
    }
    default: {
      const exhaustive: never = input.mode;
      throw new ReviewError('INVALID_INPUT', `unknown input mode ${JSON.stringify(String(exhaustive))}`);
    }
  }
}

/**
 * Recomputes changes from the fixed ids in `source`. Raw refs are never
 * resolved again, so a branch moving after prepare cannot change the review;
 * a workspace source is only reused while its fingerprint still matches.
 */
export async function changesForSource(
  git: GitObjects,
  source: ReviewSource,
  limits: ChangeLimits,
): Promise<ChangeRecord[]> {
  const expected = MODE_COMPARISON[source.mode];
  if (expected === undefined) {
    throw new ReviewError('INVALID_INPUT', `unknown review mode ${JSON.stringify(String(source.mode))}`);
  }
  if (source.comparison !== expected) {
    throw new ReviewError(
      'INVALID_INPUT',
      `comparison ${JSON.stringify(source.comparison)} does not match mode ${JSON.stringify(source.mode)}`,
    );
  }

  switch (source.mode) {
    case 'range': {
      if (source.mergeBaseSha !== undefined && source.mergeBaseSha !== source.baseSha) {
        throw new ReviewError('INVALID_INPUT', 'range source must use the merge base as baseSha');
      }
      await verifyFixedCommits(git, source.baseSha, source.headSha);
      return collectFixedChanges(git, source.baseSha, source.headSha, 'range', limits);
    }
    case 'commit': {
      await verifyFixedCommits(git, source.baseSha, source.headSha);
      return collectFixedChanges(git, source.baseSha, source.headSha, 'commit', limits);
    }
    case 'workspace': {
      const fingerprint = source.workspaceFingerprint;
      if (fingerprint === undefined || fingerprint === '') {
        throw new ReviewError('INVALID_INPUT', 'workspace source requires workspaceFingerprint');
      }
      const before = await inspectWorkspace(git, limits.maxFileBytes);
      if (before.fingerprint !== fingerprint) {
        throw new ReviewError('SOURCE_CHANGED', 'workspace changed since the review input was resolved');
      }
      const changes = await collectWorkspaceChanges(git, before, limits);
      const after = await inspectWorkspace(git, limits.maxFileBytes);
      if (after.fingerprint !== before.fingerprint) {
        throw new ReviewError('SOURCE_CHANGED', 'workspace changed while the manifest was being rebuilt');
      }
      return changes;
    }
    default: {
      const exhaustive: never = source.mode;
      throw new ReviewError('INVALID_INPUT', `unknown review mode ${JSON.stringify(String(exhaustive))}`);
    }
  }
}

export function assertSourceOwner(source: ReviewSource, repoId: string): void {
  if (source === null || typeof source !== 'object') {
    throw new ReviewError('INVALID_INPUT', 'source is required');
  }
  if (source.repoId !== repoId) {
    throw new ReviewError('INVALID_INPUT', 'source belongs to a different repository');
  }
}

/** Reconstructs the informational input record for a rebuild without raw refs. */
export function inputForSource(source: ReviewSource, override?: ReviewInput): ReviewInput {
  if (override !== undefined) {
    const normalized = normalizeReviewInput(override);
    if (normalized.mode !== source.mode) {
      throw new ReviewError('INVALID_INPUT', 'input.mode does not match source.mode');
    }
    return normalized;
  }
  switch (source.mode) {
    case 'range':
      return { mode: 'range', from: source.requestedRefs?.from ?? source.baseSha, to: source.requestedRefs?.to ?? source.headSha };
    case 'commit':
      return { mode: 'commit', commit: source.requestedRefs?.commit ?? source.headSha };
    case 'workspace':
      return { mode: 'workspace' };
    default: {
      const exhaustive: never = source.mode;
      throw new ReviewError('INVALID_INPUT', `unknown review mode ${JSON.stringify(String(exhaustive))}`);
    }
  }
}

async function verifyFixedCommits(git: GitObjects, baseSha: string, headSha: string): Promise<void> {
  if (headSha === '' || !isObjectId(headSha)) {
    throw new ReviewError('INVALID_INPUT', 'source.headSha must be a full commit id');
  }
  if (baseSha === '' || !isObjectId(baseSha)) {
    throw new ReviewError('INVALID_INPUT', 'source.baseSha must be a commit id');
  }
  await git.verifyCommit(headSha);
  await git.verifyCommit(baseSha);
}

function trimRef(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value !== 'string') {
    throw new ReviewError('INVALID_INPUT', 'input refs must be strings');
  }
  return value.trim();
}

function validateRef(ref: string): void {
  if (ref === '') {
    return;
  }
  if (/[\u0000\n\r]/u.test(ref)) {
    throw new ReviewError('INVALID_INPUT', 'input ref contains control characters');
  }
  if (ref.startsWith('-')) {
    throw new ReviewError('INVALID_INPUT', "input ref must not start with '-'");
  }
  if (Buffer.byteLength(ref, 'utf8') > 512) {
    throw new ReviewError('INVALID_INPUT', 'input ref is too long');
  }
}
