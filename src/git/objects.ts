// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
import { Buffer } from 'node:buffer';

import { ReviewError } from '../domain/errors.js';
import { escapePathspec, isObjectId, normalizeRepoPath } from './paths.js';
import { GitError, type GitRunner } from './runner.js';

/** git's well-known empty tree; diff and ls-tree resolve it without the object existing. */
export const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export interface TreeEntry {
  path: string;
  mode: string;
  type: string;
  object: string;
  /** Blob size in bytes; -1 when git does not report one (submodules). */
  size: number;
}

export interface StatusEntry {
  /** Two-character porcelain status, e.g. ` M`, `A `, `??`. */
  code: string;
  path: string;
}

const PATHSPEC_CHUNK = 200;

/**
 * Thin porcelain layer over git. Every read targets an object id or an
 * explicit revision; no call touches a working-tree file except the workspace
 * probes that are documented as mutable.
 */
export class GitObjects {
  constructor(
    readonly runner: GitRunner,
    readonly repoRoot: string,
  ) {}

  get cwd(): string {
    return this.runner.cwd;
  }

  async run(args: string[]): Promise<string> {
    return (await this.runBuffer(args)).toString('utf8');
  }

  async runBuffer(args: string[]): Promise<Buffer> {
    try {
      return await this.runner.runBuffer(args);
    } catch (error) {
      throw this.toReviewError(error);
    }
  }

  /** Runs a command whose non-zero exit is an expected answer, not a failure. */
  async tryRun(args: string[]): Promise<string | undefined> {
    try {
      return await this.runner.run(args);
    } catch (error) {
      if (error instanceof GitError && error.kind === 'failed') {
        return undefined;
      }
      throw this.toReviewError(error);
    }
  }

  async resolveCommit(ref: string): Promise<string> {
    const output = await this.run(['rev-parse', '--verify', `${ref}^{commit}`]);
    const sha = output.trim();
    if (!isObjectId(sha)) {
      throw new ReviewError('PREPARATION_FAILED', `cannot resolve ${JSON.stringify(ref)} to a commit`);
    }
    return sha;
  }

  async verifyCommit(sha: string): Promise<void> {
    if (sha === EMPTY_TREE_SHA) {
      return;
    }
    if (!isObjectId(sha)) {
      throw new ReviewError('INVALID_INPUT', `invalid commit id: ${sha}`);
    }
    const output = await this.tryRun(['rev-parse', '--verify', '--quiet', `${sha}^{commit}`]);
    if (output === undefined || output.trim().toLowerCase() !== sha.toLowerCase()) {
      throw new ReviewError('PREPARATION_FAILED', `commit ${sha} is not available in this repository`);
    }
  }

  async mergeBase(from: string, to: string): Promise<string> {
    const output = await this.run(['merge-base', from, to]);
    const sha = output.trim();
    if (!isObjectId(sha)) {
      throw new ReviewError('PREPARATION_FAILED', 'no merge base for the selected commits');
    }
    return sha;
  }

  /** Returns an empty string for a root commit. */
  async firstParent(sha: string): Promise<string> {
    const output = await this.run(['rev-list', '--parents', '-n', '1', sha]);
    const fields = output.trim().split(/\s+/u);
    return fields.length >= 2 ? (fields[1] ?? '') : '';
  }

  /** Returns an empty string for an unborn branch, which is a valid workspace input. */
  async headCommit(): Promise<string> {
    const output = await this.tryRun(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
    if (output !== undefined) {
      const sha = output.trim();
      return isObjectId(sha) ? sha : '';
    }
    const symbolic = await this.tryRun(['symbolic-ref', '--quiet', 'HEAD']);
    if (symbolic !== undefined) {
      return '';
    }
    throw new ReviewError('PREPARATION_FAILED', 'HEAD cannot be resolved');
  }

  async diff(base: string, head: string): Promise<string> {
    return this.run([
      'diff',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      '--find-renames',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      base,
      head,
      '--',
    ]);
  }

  /** Worktree against HEAD; an unborn HEAD falls back to the index against the empty tree. */
  async workspaceDiff(head: string): Promise<string> {
    const scope = head === '' ? ['diff', '--cached'] : ['diff', head];
    return this.run([
      ...scope,
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      '--find-renames',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      '--',
    ]);
  }

  async status(): Promise<StatusEntry[]> {
    const output = await this.runBuffer(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames']);
    const entries: StatusEntry[] = [];
    for (const record of output.toString('utf8').split('\0')) {
      if (record.length < 4 || record[2] !== ' ') {
        continue;
      }
      const path = normalizeRepoPath(record.slice(3));
      if (path === '') {
        continue;
      }
      entries.push({ code: record.slice(0, 2), path });
    }
    return entries;
  }

  /** Worktree paths that are tracked or untracked but not ignored. */
  async listWorktreeFiles(): Promise<string[]> {
    const output = await this.runBuffer(['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
    const paths = new Set<string>();
    for (const record of output.toString('utf8').split('\0')) {
      const path = normalizeRepoPath(record);
      if (path !== '') {
        paths.add(path);
      }
    }
    return [...paths].sort();
  }

  async lsTree(rev: string): Promise<TreeEntry[]> {
    const output = await this.runBuffer(['ls-tree', '-r', '-l', '-z', '--full-tree', rev]);
    return parseTreeOutput(output);
  }

  /** Looks up several paths at one revision with a single command per chunk. */
  async lookupPaths(rev: string, paths: readonly string[]): Promise<Map<string, TreeEntry>> {
    const unique = [...new Set(paths.map((path) => normalizeRepoPath(path)).filter((path) => path !== ''))];
    const found = new Map<string, TreeEntry>();
    for (let index = 0; index < unique.length; index += PATHSPEC_CHUNK) {
      const chunk = unique.slice(index, index + PATHSPEC_CHUNK);
      const output = await this.runBuffer([
        'ls-tree',
        '-r',
        '-l',
        '-z',
        '--full-tree',
        rev,
        '--',
        ...chunk.map((path) => escapePathspec(path)),
      ]);
      const wanted = new Set(chunk);
      for (const entry of parseTreeOutput(output)) {
        if (wanted.has(entry.path)) {
          found.set(entry.path, entry);
        }
      }
    }
    return found;
  }

  async lookupPath(rev: string, path: string): Promise<TreeEntry | undefined> {
    const normalized = normalizeRepoPath(path);
    if (normalized === '') {
      return undefined;
    }
    const entries = await this.lookupPaths(rev, [normalized]);
    return entries.get(normalized);
  }

  async readBlob(object: string): Promise<Buffer> {
    if (!isObjectId(object)) {
      throw new ReviewError('INTERNAL_ERROR', 'invalid git object id in tree entry');
    }
    return this.runBuffer(['cat-file', 'blob', object]);
  }

  private toReviewError(error: unknown): ReviewError {
    if (!(error instanceof GitError)) {
      return error instanceof ReviewError ? error : new ReviewError('INTERNAL_ERROR', String(error));
    }
    const detail = this.redact(error.message);
    if (error.kind === 'output-limit') {
      return new ReviewError('PAYLOAD_TOO_LARGE', `git ${error.command} exceeded the output limit`, { cause: error });
    }
    if (error.kind === 'timeout') {
      return new ReviewError('PREPARATION_FAILED', `git ${error.command} timed out`, { cause: error });
    }
    const suffix = detail === '' ? '' : `: ${detail}`;
    return new ReviewError('PREPARATION_FAILED', `git ${error.command} failed${suffix}`, { cause: error });
  }

  /** Never expose the absolute repository root through a tool error. */
  private redact(message: string): string {
    let text = message.split(this.repoRoot).join('<repo>');
    text = text.split(/\s+/u).join(' ').trim();
    return text.length > 300 ? text.slice(0, 300) : text;
  }
}

function parseTreeOutput(buffer: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  for (const record of buffer.toString('utf8').split('\0')) {
    if (record === '') {
      continue;
    }
    const tab = record.indexOf('\t');
    if (tab < 0) {
      continue;
    }
    const meta = record.slice(0, tab).split(' ');
    const path = normalizeRepoPath(record.slice(tab + 1));
    if (path === '' || meta.length < 4) {
      continue;
    }
    const mode = meta[0];
    const type = meta[1];
    const object = meta[2];
    const rawSize = meta[3];
    if (mode === undefined || type === undefined || object === undefined) {
      continue;
    }
    const parsed = rawSize === undefined || rawSize === '-' ? -1 : Number(rawSize);
    entries.push({ path, mode, type, object, size: Number.isFinite(parsed) ? parsed : -1 });
  }
  return entries;
}
