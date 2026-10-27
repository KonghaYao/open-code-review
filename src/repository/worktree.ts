// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
import { Buffer } from 'node:buffer';
import { lstat, readFile, readlink, realpath } from 'node:fs/promises';
import { dirname } from 'node:path';

import { ReviewError } from '../domain/errors.js';
import { isWithin, toFileSystemPath } from '../git/paths.js';

export type WorktreeKind = 'file' | 'symlink' | 'directory' | 'other';

export interface WorktreeStat {
  kind: WorktreeKind;
  size: number;
  mtimeMs: number;
}

export interface WorktreeFile {
  bytes: Buffer;
  size: number;
}

export async function lstatWorktree(root: string, repoPath: string): Promise<WorktreeStat | undefined> {
  const full = toFileSystemPath(root, repoPath);
  if (full === undefined) {
    return undefined;
  }
  try {
    const stats = await lstat(full);
    return {
      kind: kindOf(stats.isFile(), stats.isSymbolicLink(), stats.isDirectory()),
      size: stats.size,
      mtimeMs: Math.trunc(stats.mtimeMs),
    };
  } catch (error) {
    if (isMissing(error)) {
      return undefined;
    }
    throw new ReviewError('PREPARATION_FAILED', 'cannot inspect a worktree path', { cause: error });
  }
}

/**
 * Reads one live worktree file. A symbolic link resolves to its target text
 * rather than the linked file, and a path whose real parent escapes the
 * repository root is rejected instead of followed.
 */
export async function readWorktreeFile(root: string, repoPath: string): Promise<WorktreeFile | undefined> {
  const full = toFileSystemPath(root, repoPath);
  if (full === undefined) {
    return undefined;
  }
  const stats = await lstatWorktree(root, repoPath);
  if (stats === undefined) {
    return undefined;
  }
  if (stats.kind === 'symlink') {
    const target = await readlinkWorktree(full);
    return target === undefined ? undefined : { bytes: Buffer.from(target, 'utf8'), size: Buffer.byteLength(target, 'utf8') };
  }
  if (stats.kind !== 'file') {
    return undefined;
  }
  await assertContained(root, full);
  try {
    const bytes = await readFile(full);
    return { bytes, size: bytes.length };
  } catch (error) {
    if (isMissing(error)) {
      return undefined;
    }
    throw new ReviewError('PREPARATION_FAILED', 'cannot read a worktree file', { cause: error });
  }
}

async function readlinkWorktree(full: string): Promise<string | undefined> {
  try {
    return await readlink(full);
  } catch (error) {
    if (isMissing(error)) {
      return undefined;
    }
    throw new ReviewError('PREPARATION_FAILED', 'cannot read a worktree symbolic link', { cause: error });
  }
}

async function assertContained(root: string, full: string): Promise<void> {
  let directory: string;
  try {
    directory = await realpath(dirname(full));
  } catch (error) {
    if (isMissing(error)) {
      return;
    }
    throw new ReviewError('PREPARATION_FAILED', 'cannot resolve a worktree path', { cause: error });
  }
  if (!isWithin(root, directory)) {
    throw new ReviewError('INVALID_INPUT', 'path escapes the repository root');
  }
}

function kindOf(isFile: boolean, isSymbolicLink: boolean, isDirectory: boolean): WorktreeKind {
  if (isSymbolicLink) {
    return 'symlink';
  }
  if (isFile) {
    return 'file';
  }
  return isDirectory ? 'directory' : 'other';
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}
