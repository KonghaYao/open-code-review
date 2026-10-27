// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
import { Buffer } from 'node:buffer';

import { ReviewError } from '../domain/errors.js';
import { CHANGE_SIDES, type ChangeSide, type ReviewSource } from '../domain/types.js';
import { digestBytes } from '../git/hash.js';
import { isObjectId, normalizeRepoPath } from '../git/paths.js';
import type { RepositoryContext } from './context.js';
import { isProviderPath, isSecretPath } from './exclusions.js';
import { inspectWorkspace } from './workspace.js';
import { readWorktreeFile } from './worktree.js';

export interface LoadedSourceFile {
  bytes: Buffer;
  digest: string;
  size: number;
}

export function assertChangeSide(value: unknown): ChangeSide {
  if (typeof value === 'string' && (CHANGE_SIDES as readonly string[]).includes(value)) {
    return value as ChangeSide;
  }
  throw new ReviewError('INVALID_INPUT', 'side must be base, head or workspace');
}

/**
 * Loads file content from the fixed side of a source. Fixed modes read git
 * objects at the recorded SHAs; workspace mode reads the live worktree after
 * callers verify the fingerprint, and never copies anything to disk.
 */
export class SourceContent {
  private readonly context: RepositoryContext;

  constructor(context: RepositoryContext) {
    this.context = context;
  }

  /** Fails with SOURCE_CHANGED when a workspace moved after it was resolved. */
  async assertFresh(source: ReviewSource): Promise<void> {
    if (source.mode !== 'workspace') {
      return;
    }
    const fingerprint = source.workspaceFingerprint;
    if (fingerprint === undefined || fingerprint === '') {
      throw new ReviewError('INVALID_INPUT', 'workspace source requires workspaceFingerprint');
    }
    const workspace = await inspectWorkspace(this.context.git, this.context.options.maxFileBytes);
    if (workspace.fingerprint !== fingerprint) {
      throw new ReviewError('SOURCE_CHANGED', 'workspace changed since the review input was resolved');
    }
  }

  async load(source: ReviewSource, rawPath: string, side: ChangeSide): Promise<LoadedSourceFile | undefined> {
    const path = normalizeRepoPath(rawPath);
    if (path === '') {
      throw new ReviewError('INVALID_INPUT', 'path is required');
    }
    if (isSecretPath(path)) {
      throw new ReviewError('INVALID_INPUT', 'secret paths are never readable');
    }
    if (isProviderPath(path)) {
      throw new ReviewError('INVALID_INPUT', 'path is outside the reviewable source');
    }

    if (side === 'workspace') {
      if (source.mode !== 'workspace') {
        throw new ReviewError('INVALID_INPUT', 'workspace side is only available for workspace reviews');
      }
      const file = await readWorktreeFile(this.context.repoRoot, path);
      return file === undefined ? undefined : { bytes: file.bytes, digest: digestBytes(file.bytes), size: file.size };
    }

    const revision = side === 'base' ? source.baseSha : source.headSha;
    if (revision === '') {
      throw new ReviewError('INVALID_INPUT', `the ${side} side has no revision for this source`);
    }
    if (!isObjectId(revision)) {
      throw new ReviewError('INVALID_INPUT', `the ${side} side revision is not a full object id`);
    }
    const entry = await this.context.git.lookupPath(revision, path);
    if (entry === undefined || entry.type !== 'blob') {
      return undefined;
    }
    const bytes = await this.context.git.readBlob(entry.object);
    return { bytes, digest: digestBytes(bytes), size: bytes.length };
  }
}
