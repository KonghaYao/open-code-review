// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
import { ReviewError } from '../domain/errors.js';
import type { NormalizedReviewScope, ReviewScope } from '../domain/types.js';
import { compileGlob, normalizePathSeparators } from '../git/glob.js';

/**
 * Applies the documented defaults (tests and deletions are included) and
 * validates every glob before it is used for unit selection.
 */
export function normalizeScope(scope?: ReviewScope): NormalizedReviewScope {
  const include = cleanPatterns(scope?.include, 'include');
  const exclude = cleanPatterns(scope?.exclude, 'exclude');
  for (const pattern of [...include, ...exclude]) {
    compileGlob(pattern);
  }
  return {
    include,
    exclude,
    includeTests: scope?.includeTests ?? true,
    includeDeleted: scope?.includeDeleted ?? true,
  };
}

function cleanPatterns(patterns: readonly string[] | undefined, field: string): string[] {
  const cleaned: string[] = [];
  const seen = new Set<string>();
  for (const raw of patterns ?? []) {
    if (typeof raw !== 'string') {
      throw new ReviewError('INVALID_INPUT', `scope.${field} entries must be strings`);
    }
    const pattern = normalizePathSeparators(raw.trim());
    if (pattern === '' || seen.has(pattern)) {
      continue;
    }
    seen.add(pattern);
    cleaned.push(pattern);
  }
  return cleaned;
}
