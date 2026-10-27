// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import { ReviewError } from '../domain/errors.js';
import { sha256Hex } from '../git/hash.js';
import { GitObjects } from '../git/objects.js';
import { GitRunner } from '../git/runner.js';
import { resolveRepositoryOptions, type RepositoryOptions, type ResolvedRepositoryOptions } from './options.js';

/**
 * Binds one repository root and one git runner. Discovery is lazy because the
 * factories are synchronous, but every async entry point awaits `ready()`.
 */
export class RepositoryContext {
  readonly options: ResolvedRepositoryOptions;
  private readonly initialRoot: string;
  private rootPath: string;
  private repoIdentifier = '';
  private gitObjects: GitObjects | undefined;
  private initPromise: Promise<void> | undefined;

  constructor(repoRoot: string, options: RepositoryOptions = {}) {
    if (typeof repoRoot !== 'string' || repoRoot.trim() === '') {
      throw new ReviewError('INVALID_INPUT', 'repository root is required');
    }
    this.initialRoot = resolve(repoRoot);
    this.rootPath = this.initialRoot;
    this.options = resolveRepositoryOptions(options);
  }

  get repoRoot(): string {
    return this.rootPath;
  }

  get git(): GitObjects {
    if (this.gitObjects === undefined) {
      throw new ReviewError('INTERNAL_ERROR', 'repository context is not initialized');
    }
    return this.gitObjects;
  }

  ready(): Promise<void> {
    this.initPromise ??= this.initialize();
    return this.initPromise;
  }

  async repoId(): Promise<string> {
    await this.ready();
    return this.repoIdentifier;
  }

  private async initialize(): Promise<void> {
    let stats;
    try {
      stats = await stat(this.initialRoot);
    } catch (error) {
      throw new ReviewError('INVALID_INPUT', 'repository root is not a readable directory', { cause: error });
    }
    if (!stats.isDirectory()) {
      throw new ReviewError('INVALID_INPUT', 'repository root is not a readable directory');
    }

    let canonicalRoot: string;
    try {
      canonicalRoot = await realpath(this.initialRoot);
    } catch (error) {
      throw new ReviewError('INVALID_INPUT', 'repository root cannot be resolved', { cause: error });
    }

    const runnerOptions = {
      cwd: canonicalRoot,
      gitPath: this.options.gitPath,
      timeoutMs: this.options.gitTimeoutMs,
      maxBufferBytes: this.options.gitMaxBufferBytes,
      maxConcurrent: this.options.gitMaxConcurrent,
    };
    const probe = new GitObjects(new GitRunner(runnerOptions), canonicalRoot);
    const top = (await probe.run(['rev-parse', '--show-toplevel'])).trim();
    if (top === '') {
      throw new ReviewError('PREPARATION_FAILED', 'git reported an empty repository root');
    }
    if ((await probe.run(['rev-parse', '--is-inside-work-tree'])).trim() !== 'true') {
      throw new ReviewError('INVALID_INPUT', 'repository root is not a git work tree');
    }

    let canonicalTop: string;
    try {
      canonicalTop = await realpath(top);
    } catch (error) {
      throw new ReviewError('PREPARATION_FAILED', 'git top-level cannot be resolved', { cause: error });
    }

    this.rootPath = canonicalTop;
    this.gitObjects = new GitObjects(new GitRunner({ ...runnerOptions, cwd: canonicalTop }), canonicalTop);
    this.repoIdentifier = `repo_${sha256Hex(canonicalTop).slice(0, 32)}`;
  }
}
