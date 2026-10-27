// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
import { digestBytes } from '../git/hash.js';
import type { GitObjects, StatusEntry } from '../git/objects.js';
import { isSecretPath } from './exclusions.js';
import { lstatWorktree, readWorktreeFile } from './worktree.js';

export interface WorkspaceSnapshot {
  headSha: string;
  fingerprint: string;
  status: StatusEntry[];
  untracked: string[];
}

/**
 * Fingerprints the mutable worktree. It covers HEAD, every status entry (which
 * carries both index and worktree state), the content digest of each changed
 * path, deletions and vanished files. Secret paths contribute metadata only so
 * the fingerprint never touches their bytes.
 */
export async function inspectWorkspace(git: GitObjects, maxFileBytes: number): Promise<WorkspaceSnapshot> {
  const headSha = await git.headCommit();
  const status = [...(await git.status())].sort((left, right) => compare(left.path, right.path));
  const untracked = status.filter((entry) => entry.code === '??').map((entry) => entry.path);
  const parts: string[] = [`head\0${headSha}\0`];

  const fingerprints = await Promise.all(
    status.map(
      async (entry) =>
        `${entry.code}\0${entry.path}\0${await contentFingerprint(git.repoRoot, entry.path, maxFileBytes)}\0`,
    ),
  );

  return { headSha, status, untracked, fingerprint: digestBytes(parts.concat(fingerprints).join('')) };
}

async function contentFingerprint(root: string, path: string, maxFileBytes: number): Promise<string> {
  const secret = isSecretPath(path);
  const stats = await lstatWorktree(root, path);
  if (stats === undefined) {
    return secret ? 'secret:absent' : 'absent';
  }
  if (secret) {
    return `secret:${stats.size}:${stats.mtimeMs}`;
  }
  if (stats.kind === 'symlink') {
    const file = await readWorktreeFile(root, path);
    return file === undefined ? 'symlink:error' : `symlink:${digestBytes(file.bytes)}`;
  }
  if (stats.kind !== 'file') {
    return `special:${stats.kind}`;
  }
  if (stats.size > maxFileBytes) {
    return `large:${stats.size}:${stats.mtimeMs}`;
  }
  const file = await readWorktreeFile(root, path);
  return file === undefined ? 'error' : digestBytes(file.bytes);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
