// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
import { join, sep } from 'node:path';

/**
 * Makes a path repository-relative and rejects anything that could escape the
 * root once joined to a directory. Backslashes are folded so a Windows-style
 * separator never becomes a legitimate file-name character.
 */
export function normalizeRepoPath(input: string): string {
  let path = input.replaceAll('\\', '/');
  if (path.startsWith('./')) {
    path = path.slice(2);
  }
  if (path.startsWith('/')) {
    path = path.slice(1);
  }
  if (path === '' || path === '.') {
    return '';
  }
  for (const segment of path.split('/')) {
    if (segment === '..') {
      return '';
    }
  }
  return path;
}

export function isObjectId(value: string): boolean {
  if (value.length !== 40 && value.length !== 64) {
    return false;
  }
  for (const character of value) {
    const code = character.charCodeAt(0);
    const digit = code >= 0x30 && code <= 0x39;
    const lower = code >= 0x61 && code <= 0x66;
    const upper = code >= 0x41 && code <= 0x46;
    if (!digit && !lower && !upper) {
      return false;
    }
  }
  return true;
}

/** Pathspec magic keeps glob characters inside a file name literal. */
export function escapePathspec(path: string): string {
  return `:(literal)${path}`;
}

/** Joins a normalized repository path onto a directory root. */
export function toFileSystemPath(root: string, repoPath: string): string | undefined {
  const normalized = normalizeRepoPath(repoPath);
  if (normalized === '') {
    return undefined;
  }
  return join(root, ...normalized.split('/'));
}

/** Reports whether target is base itself or contained under base. */
export function isWithin(base: string, target: string): boolean {
  if (base === '') {
    return false;
  }
  if (target === base) {
    return true;
  }
  return target.startsWith(base.endsWith(sep) ? base : base + sep);
}
