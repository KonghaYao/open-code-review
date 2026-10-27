// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
import { ReviewError } from '../domain/errors.js';
import {
  CHANGE_SIDES,
  type ChangeSide,
  type Location,
  type LocationValidation,
  type ReviewSource,
} from '../domain/types.js';
import { isBinaryContent, splitContentLines } from '../git/content.js';
import { digestLines } from '../git/hash.js';
import { normalizeRepoPath } from '../git/paths.js';
import type { SourceContent } from './content.js';
import { isProviderPath, isSecretPath } from './exclusions.js';

/**
 * Validates a model-supplied location against the exact side it claims. Line
 * numbers are never trusted on their own: the snippet must match, and an
 * ambiguous snippet is reported as unlocated instead of being guessed.
 */
export async function verifyLocation(
  content: SourceContent,
  source: ReviewSource,
  location: Location,
  maxFileBytes: number,
): Promise<LocationValidation> {
  const side = assertFindingSide(location.side);
  const path = normalizeRepoPath(typeof location.path === 'string' ? location.path : '');
  if (path === '') {
    throw new ReviewError('INVALID_FINDING', 'location.path is required');
  }
  if (isSecretPath(path)) {
    throw new ReviewError('INVALID_FINDING', 'secret paths are never readable');
  }
  if (isProviderPath(path)) {
    throw new ReviewError('INVALID_FINDING', 'path is outside the reviewable source');
  }

  await content.assertFresh(source);
  const loaded = await content.load(source, path, side);
  if (loaded === undefined) {
    return { located: false, side, note: `path is not part of the resolved ${side} source` };
  }
  if (isBinaryContent(loaded.bytes)) {
    return { located: false, side, note: 'file is binary; the location cannot be verified' };
  }
  if (loaded.size > maxFileBytes) {
    return { located: false, side, note: 'file is larger than the readable limit' };
  }

  const lines = splitContentLines(loaded.bytes);
  const snippet = splitSnippet(typeof location.snippet === 'string' ? location.snippet : '');
  if (snippet.length === 0) {
    return { located: false, side, note: 'snippet is empty; location cannot be verified' };
  }

  const startLine = Number(location.startLine);
  const endLine = Number(location.endLine);
  if (Number.isInteger(startLine) && Number.isInteger(endLine) && startLine > 0 && endLine >= startLine) {
    const start = startLine - 1;
    const end = endLine;
    if (end <= lines.length && rangeMatches(lines.slice(start, end), snippet)) {
      return { located: true, side, startLine, endLine, digest: digestLines(lines.slice(start, end)) };
    }
  }

  const matches = findOccurrences(lines, snippet);
  if (matches.length === 0) {
    return { located: false, side, note: 'snippet not found on this side of the resolved source' };
  }
  if (matches.length === 1) {
    const start = matches[0] ?? 0;
    return {
      located: true,
      side,
      startLine: start + 1,
      endLine: start + snippet.length,
      digest: digestLines(lines.slice(start, start + snippet.length)),
    };
  }
  return {
    located: false,
    side,
    note: `snippet matches ${matches.length} places (${formatLines(matches)}); add surrounding context`,
  };
}

function assertFindingSide(value: unknown): ChangeSide {
  if (typeof value === 'string' && (CHANGE_SIDES as readonly string[]).includes(value)) {
    return value as ChangeSide;
  }
  throw new ReviewError('INVALID_FINDING', 'location.side must be base, head or workspace');
}

function splitSnippet(snippet: string): string[] {
  const raw = snippet.replaceAll('\r\n', '\n').split('\n');
  let start = 0;
  let end = raw.length;
  while (start < end && (raw[start] ?? '').trim() === '') {
    start += 1;
  }
  while (end > start && (raw[end - 1] ?? '').trim() === '') {
    end -= 1;
  }
  return raw.slice(start, end).map((line) => line.replace(/[ \t\r]+$/u, ''));
}

function rangeMatches(actual: readonly string[], snippet: readonly string[]): boolean {
  if (actual.length < snippet.length) {
    return false;
  }
  for (let index = 0; index < snippet.length; index += 1) {
    if ((actual[index] ?? '').replace(/[ \t\r]+$/u, '') !== snippet[index]) {
      return false;
    }
  }
  return true;
}

function findOccurrences(lines: readonly string[], snippet: readonly string[]): number[] {
  const matches: number[] = [];
  for (let index = 0; index + snippet.length <= lines.length; index += 1) {
    if (rangeMatches(lines.slice(index, index + snippet.length), snippet)) {
      matches.push(index);
      if (matches.length > 20) {
        break;
      }
    }
  }
  return matches;
}

function formatLines(matches: readonly number[]): string {
  return matches.map((match) => `line ${match + 1}`).join(', ');
}
