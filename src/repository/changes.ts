// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
import type { ChangeSide } from '../domain/types.js';
import { isBinaryContent } from '../git/content.js';
import {
  buildAddDiff,
  buildBinaryAddDiff,
  parseUnifiedDiff,
  type ChangeStatus,
  type DiffBlock,
  type DiffHunk,
} from '../git/diff.js';
import { shortHash } from '../git/hash.js';
import type { GitObjects, TreeEntry } from '../git/objects.js';
import { normalizeRepoPath } from '../git/paths.js';
import { isProviderPath, isSecretPath, isTestPath } from './exclusions.js';
import { lstatWorktree, readWorktreeFile } from './worktree.js';
import type { WorkspaceSnapshot } from './workspace.js';

export type ChangeSource = 'range' | 'commit' | 'workspace' | 'untracked';

export interface ChangeRecord {
  changeId: string;
  status: ChangeStatus;
  oldPath: string;
  newPath: string;
  source: ChangeSource;
  binary: boolean;
  submodule: boolean;
  isTest: boolean;
  insertions: number;
  deletions: number;
  diff: string;
  diffTruncated: boolean;
  hunks: DiffHunk[];
  /** Byte size on the side that carries content; -1 when unknown. */
  size: number;
}

export interface ChangeLimits {
  maxDiffBytes: number;
  maxFileBytes: number;
}

export function effectivePath(change: ChangeRecord): string {
  return change.newPath !== '' ? change.newPath : change.oldPath;
}

/** Renames keep both paths; the current path comes first. */
export function changePaths(change: ChangeRecord): string[] {
  const paths: string[] = [];
  if (change.newPath !== '') {
    paths.push(change.newPath);
  }
  if (change.oldPath !== '' && change.oldPath !== change.newPath) {
    paths.push(change.oldPath);
  }
  return paths;
}

export function changeSide(change: ChangeRecord): ChangeSide {
  if (change.newPath === '') {
    return 'base';
  }
  return change.source === 'workspace' || change.source === 'untracked' ? 'workspace' : 'head';
}

export function changeIdFor(source: string, status: string, oldPath: string, newPath: string): string {
  return `ch_${shortHash(source, status, oldPath, newPath)}`;
}

/** Turns parsed blocks into change records; secret diffs are cleared before they can be stored. */
export function changesFromBlocks(blocks: readonly DiffBlock[], source: ChangeSource): ChangeRecord[] {
  const changes: ChangeRecord[] = [];
  for (const block of blocks) {
    const path = block.newPath !== '' ? block.newPath : block.oldPath;
    if (path === '') {
      continue;
    }
    const secret = isSecretPath(block.oldPath) || isSecretPath(block.newPath);
    changes.push({
      changeId: changeIdFor(source, block.status, block.oldPath, block.newPath),
      status: block.status,
      oldPath: block.oldPath,
      newPath: block.newPath,
      source,
      binary: secret ? false : block.binary,
      submodule: false,
      isTest: isTestPath(path),
      insertions: secret ? 0 : block.insertions,
      deletions: secret ? 0 : block.deletions,
      diff: secret ? '' : block.text,
      diffTruncated: secret ? false : block.truncated,
      hunks: secret ? [] : block.hunks,
      size: -1,
    });
  }
  return changes;
}

/** Collects the changes of a fixed commit pair; nothing reads the worktree. */
export async function collectFixedChanges(
  git: GitObjects,
  baseSha: string,
  headSha: string,
  source: 'range' | 'commit',
  limits: ChangeLimits,
): Promise<ChangeRecord[]> {
  const raw = await git.diff(baseSha, headSha);
  const changes = changesFromBlocks(parseUnifiedDiff(raw, limits.maxDiffBytes), source);
  const oldPaths = changes.filter((change) => change.newPath === '' && change.oldPath !== '').map((c) => c.oldPath);
  const newPaths = changes.filter((change) => change.newPath !== '').map((change) => change.newPath);
  const [oldEntries, newEntries] = await Promise.all([
    git.lookupPaths(baseSha, oldPaths),
    git.lookupPaths(headSha, newPaths),
  ]);
  for (const change of changes) {
    applyTreeEntry(change, change.newPath !== '' ? newEntries.get(change.newPath) : oldEntries.get(change.oldPath));
  }
  return changes;
}

/** Collects tracked worktree changes against HEAD plus agreed untracked files. */
export async function collectWorkspaceChanges(
  git: GitObjects,
  workspace: WorkspaceSnapshot,
  limits: ChangeLimits,
): Promise<ChangeRecord[]> {
  const raw = await git.workspaceDiff(workspace.headSha);
  const changes = changesFromBlocks(parseUnifiedDiff(raw, limits.maxDiffBytes), 'workspace');

  const trackedNew = new Set(changes.map((change) => change.newPath).filter((path) => path !== ''));
  const deleted = changes.filter((change) => change.newPath === '');
  const oldEntries =
    workspace.headSha === ''
      ? new Map<string, TreeEntry>()
      : await git.lookupPaths(
          workspace.headSha,
          deleted.map((change) => change.oldPath),
        );

  for (const change of changes) {
    if (change.newPath === '') {
      applyTreeEntry(change, oldEntries.get(change.oldPath));
      continue;
    }
    const stats = await lstatWorktree(git.repoRoot, change.newPath);
    if (stats === undefined) {
      continue;
    }
    if (stats.kind === 'directory') {
      change.submodule = true;
      continue;
    }
    change.size = stats.size;
  }

  const untracked: ChangeRecord[] = [];
  for (const path of workspace.untracked) {
    if (trackedNew.has(path)) {
      continue;
    }
    const change = await buildUntrackedChange(git.repoRoot, path, limits);
    if (change !== undefined) {
      untracked.push(change);
    }
  }
  return [...changes, ...untracked];
}

function applyTreeEntry(change: ChangeRecord, entry: TreeEntry | undefined): void {
  if (entry === undefined) {
    return;
  }
  change.size = entry.size < 0 ? 0 : entry.size;
  change.submodule = entry.type === 'commit';
}

async function buildUntrackedChange(root: string, rawPath: string, limits: ChangeLimits): Promise<ChangeRecord | undefined> {
  const path = normalizeRepoPath(rawPath);
  if (path === '') {
    return undefined;
  }
  const base = emptyChange('untracked', 'added', '', path);
  // A secret or dependency path is listed but never opened.
  if (isSecretPath(path) || isProviderPath(path)) {
    return base;
  }
  const stats = await lstatWorktree(root, path);
  if (stats === undefined) {
    return undefined;
  }
  if (stats.kind === 'directory') {
    return { ...base, submodule: true };
  }
  if (stats.kind === 'file' && stats.size > limits.maxFileBytes) {
    return { ...base, size: stats.size };
  }
  const file = await readWorktreeFile(root, path);
  if (file === undefined) {
    return undefined;
  }
  const binary = isBinaryContent(file.bytes);
  const diff = binary ? buildBinaryAddDiff(path) : buildAddDiff(path, file.bytes);
  const block = parseUnifiedDiff(diff, limits.maxDiffBytes)[0];
  return {
    ...base,
    binary,
    insertions: block?.insertions ?? 0,
    deletions: block?.deletions ?? 0,
    diff: block?.text ?? diff,
    diffTruncated: block?.truncated ?? false,
    hunks: block?.hunks ?? [],
    size: file.size,
  };
}

function emptyChange(
  source: ChangeSource,
  status: ChangeStatus,
  oldPath: string,
  newPath: string,
): ChangeRecord {
  return {
    changeId: changeIdFor(source, status, oldPath, newPath),
    status,
    oldPath,
    newPath,
    source,
    binary: false,
    submodule: false,
    isTest: isTestPath(newPath !== '' ? newPath : oldPath),
    insertions: 0,
    deletions: 0,
    diff: '',
    diffTruncated: false,
    hunks: [],
    size: -1,
  };
}
