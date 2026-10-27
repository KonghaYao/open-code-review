// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
import { ReviewError } from '../domain/errors.js';

/**
 * Minimal doublestar-compatible matcher for the patterns accepted by scope
 * filters and the built-in test/provider lists: `**`, `*`, `?`, character
 * classes and `{a,b}` alternation. Matching is anchored and case-sensitive, as
 * git path matching is.
 */
const CACHE_LIMIT = 512;
const cache = new Map<string, RegExp>();

export function compileGlob(pattern: string): RegExp {
  const cached = cache.get(pattern);
  if (cached !== undefined) {
    return cached;
  }
  const source = translate(pattern);
  let compiled: RegExp;
  try {
    compiled = new RegExp(`^${source}$`, 'u');
  } catch (error) {
    throw new ReviewError('INVALID_INPUT', `invalid glob pattern ${JSON.stringify(pattern)}`, { cause: error });
  }
  if (cache.size >= CACHE_LIMIT) {
    cache.clear();
  }
  cache.set(pattern, compiled);
  return compiled;
}

export function matchesGlob(pattern: string, path: string): boolean {
  return compileGlob(pattern).test(normalizePathSeparators(path));
}

export function matchesAnyGlob(patterns: readonly string[], path: string): boolean {
  const normalized = normalizePathSeparators(path);
  return patterns.some((pattern) => compileGlob(pattern).test(normalized));
}

export function normalizePathSeparators(path: string): string {
  return path.replaceAll('\\', '/');
}

function translate(pattern: string): string {
  let output = '';
  let braceDepth = 0;
  let index = 0;
  while (index < pattern.length) {
    const character = pattern[index];
    if (character === undefined) {
      break;
    }
    if (character === '\\') {
      const next = pattern[index + 1];
      output += escapeRegex(next ?? '\\');
      index += next === undefined ? 1 : 2;
      continue;
    }
    if (character === '*') {
      let end = index + 1;
      while (pattern[end] === '*') {
        end += 1;
      }
      if (end > index + 1) {
        // `**/` spans zero or more directories; a bare `**` spans anything.
        if (pattern[end] === '/') {
          output += '(?:[^/]+/)*';
          index = end + 1;
        } else {
          output += '.*';
          index = end;
        }
        continue;
      }
      output += '[^/]*';
      index += 1;
      continue;
    }
    if (character === '?') {
      output += '[^/]';
      index += 1;
      continue;
    }
    if (character === '[') {
      const end = findClassEnd(pattern, index);
      if (end === -1) {
        throw new ReviewError('INVALID_INPUT', `unterminated character class in glob ${JSON.stringify(pattern)}`);
      }
      let body = pattern.slice(index + 1, end);
      if (body.startsWith('!')) {
        body = `^${body.slice(1)}`;
      }
      output += `[${body}]`;
      index = end + 1;
      continue;
    }
    if (character === '{') {
      braceDepth += 1;
      output += '(?:';
      index += 1;
      continue;
    }
    if (character === '}') {
      if (braceDepth === 0) {
        throw new ReviewError('INVALID_INPUT', `unbalanced brace in glob ${JSON.stringify(pattern)}`);
      }
      braceDepth -= 1;
      output += ')';
      index += 1;
      continue;
    }
    if (character === ',' && braceDepth > 0) {
      output += '|';
      index += 1;
      continue;
    }
    output += escapeRegex(character);
    index += 1;
  }
  if (braceDepth !== 0) {
    throw new ReviewError('INVALID_INPUT', `unbalanced brace in glob ${JSON.stringify(pattern)}`);
  }
  return output;
}

function findClassEnd(pattern: string, start: number): number {
  for (let index = start + 1; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '\\') {
      index += 1;
      continue;
    }
    if (character === ']' && index > start + 1) {
      return index;
    }
  }
  return -1;
}

function escapeRegex(character: string): string {
  return /[.*+?^${}()|[\]\\]/u.test(character) ? `\\${character}` : character;
}
