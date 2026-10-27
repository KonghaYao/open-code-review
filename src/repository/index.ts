// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
import type { Reader, Repository } from '../domain/interfaces.js';
import type {
  Location,
  LocationValidation,
  NormalizedReviewScope,
  PrepareCodeReviewInput,
  PrepareCodeReviewOutput,
  ReviewInput,
  ReviewManifest,
  ReviewScope,
  ReviewSource,
} from '../domain/types.js';
import type { ChangeLimits } from './changes.js';
import { RepositoryContext } from './context.js';
import { SourceContent } from './content.js';
import {
  buildManifest,
  decodeCursor,
  encodeCursor,
  queryHash,
  type CursorBinding,
  type ManifestIdentity,
} from './manifest.js';
import type { RepositoryOptions } from './options.js';
import { planUnits, type UnitPlan } from './plan.js';
import { GitReader } from './reader.js';
import { normalizeScope } from './scope.js';
import {
  assertSourceOwner,
  changesForSource,
  inputForSource,
  normalizeReviewInput,
  resolveReviewSource,
} from './source.js';
import { verifyLocation as verifySourceLocation } from './verify.js';
import { inspectWorkspace } from './workspace.js';

/**
 * Git-backed review boundary. One instance is bound to one repository root; the
 * root and the git runner are resolved lazily on first use so the factory stays
 * synchronous.
 */
export class GitRepository implements Repository {
  private readonly context: RepositoryContext;
  private readonly content: SourceContent;
  /** Read-only view over the same repository and options. */
  readonly reader: GitReader;

  constructor(repoRoot: string, options: RepositoryOptions = {}) {
    this.context = new RepositoryContext(repoRoot, options);
    this.content = new SourceContent(this.context);
    this.reader = new GitReader(this.context);
  }

  get repoRoot(): string {
    return this.context.repoRoot;
  }

  async getRepoId(): Promise<string> {
    return this.context.repoId();
  }

  async prepareCodeReview(input: PrepareCodeReviewInput): Promise<PrepareCodeReviewOutput> {
    await this.context.ready();
    const repoId = await this.context.repoId();
    const reviewInput = normalizeReviewInput(input?.input);
    const scope = normalizeScope(input?.scope);
    const { source, changes } = await resolveReviewSource(this.context.git, repoId, reviewInput, this.limits());
    const manifest = this.buildManifest(reviewInput, source, scope, changes);
    const binding: CursorBinding = {
      reviewKey: manifest.reviewKey,
      manifestDigest: manifest.manifestDigest,
      query: queryHash(reviewInput, scope),
      total: manifest.totalUnits,
    };

    const offset = decodeCursor(input?.cursor, binding);
    const total = manifest.totalUnits;
    const pageSize = this.context.options.pageSize;
    const pageEnd = Math.min(offset + pageSize, total);
    const background = typeof input?.background === 'string' ? input.background.trim() : '';

    return {
      source: manifest.source,
      scope: manifest.scope,
      ...(background === '' ? {} : { background }),
      units: manifest.units.slice(offset, pageEnd),
      excluded: manifest.excluded,
      manifestDigest: manifest.manifestDigest,
      totalUnits: total,
      rulesDigest: manifest.rulesDigest,
      skillDigests: manifest.skillDigests,
      serverVersion: manifest.serverVersion,
      reviewKey: manifest.reviewKey,
      ...(pageEnd < total ? { nextCursor: encodeCursor(binding, pageEnd) } : {}),
    };
  }

  async rebuildManifest(
    source: ReviewSource,
    scope: ReviewScope | undefined,
    input?: ReviewInput,
  ): Promise<ReviewManifest> {
    await this.context.ready();
    assertSourceOwner(source, await this.context.repoId());
    const reviewInput = inputForSource(source, input);
    const normalizedScope = normalizeScope(scope);
    const changes = await changesForSource(this.context.git, source, this.limits());
    return this.buildManifest(reviewInput, source, normalizedScope, changes);
  }

  async verifyLocation(source: ReviewSource, location: Location): Promise<LocationValidation> {
    await this.context.ready();
    assertSourceOwner(source, await this.context.repoId());
    return verifySourceLocation(this.content, source, location, this.context.options.maxFileBytes);
  }

  async currentFingerprint(source: ReviewSource): Promise<string | undefined> {
    await this.context.ready();
    assertSourceOwner(source, await this.context.repoId());
    if (source.mode !== 'workspace') {
      return undefined;
    }
    const workspace = await inspectWorkspace(this.context.git, this.context.options.maxFileBytes);
    return workspace.fingerprint;
  }

  private limits(): ChangeLimits {
    return {
      maxDiffBytes: this.context.options.maxDiffBytes,
      maxFileBytes: this.context.options.maxFileBytes,
    };
  }

  private buildManifest(
    input: ReviewInput,
    source: ReviewSource,
    scope: NormalizedReviewScope,
    changes: Parameters<typeof planUnits>[0],
  ): ReviewManifest {
    const plan: UnitPlan = planUnits(changes, {
      scope,
      maxFileBytes: this.context.options.maxFileBytes,
      ...this.context.options.planning,
    });
    const identity: ManifestIdentity = this.context.options.identity;
    return buildManifest({ input, source, scope, units: plan.units, excluded: plan.excluded, identity });
  }
}

export function createRepository(repoRoot: string, options?: RepositoryOptions): GitRepository {
  return new GitRepository(repoRoot, options);
}

/**
 * Builds a reader over the same repository. Without an explicit target the
 * process working directory is used, which is how the server locates the
 * repository it was started in; a source from another repository is rejected
 * by the repo id check rather than read.
 */
export function createReader(target?: string | RepositoryContext | GitRepository): Reader {
  if (target instanceof GitRepository) {
    return target.reader;
  }
  if (target instanceof RepositoryContext) {
    return new GitReader(target);
  }
  return new GitReader(new RepositoryContext(target ?? process.cwd()));
}

export { GitRepository as PlaceholderRepository };
export { GitReader as PlaceholderReader };
