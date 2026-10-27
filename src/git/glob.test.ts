// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
import { describe, expect, it } from 'vitest';

import { ReviewError } from '../domain/errors.js';
import { compileGlob, matchesAnyGlob, matchesGlob } from './glob.js';

describe('glob matching', () => {
  it('anchors the whole path', () => {
    expect(matchesGlob('src/*.ts', 'src/app.ts')).toBe(true);
    expect(matchesGlob('src/*.ts', 'src/deep/app.ts')).toBe(false);
    expect(matchesGlob('src/*.ts', 'xsrc/app.ts')).toBe(false);
  });

  it('spans zero or more directories with a doublestar prefix', () => {
    expect(matchesGlob('**/*.test.ts', 'app.test.ts')).toBe(true);
    expect(matchesGlob('**/*.test.ts', 'src/deep/app.test.ts')).toBe(true);
    expect(matchesGlob('**/tests/**', 'tests/a.ts')).toBe(true);
    expect(matchesGlob('**/tests/**', 'src/tests/a.ts')).toBe(true);
    expect(matchesGlob('**/tests/**', 'src/tests')).toBe(false);
  });

  it('treats a bare doublestar as anything', () => {
    expect(matchesGlob('docs/**', 'docs/a/b.md')).toBe(true);
    expect(matchesGlob('docs/**', 'docs')).toBe(false);
  });

  it('supports single-character wildcards and character classes', () => {
    expect(matchesGlob('a?.ts', 'ab.ts')).toBe(true);
    expect(matchesGlob('a?.ts', 'abc.ts')).toBe(false);
    expect(matchesGlob('[abc].ts', 'b.ts')).toBe(true);
    expect(matchesGlob('[!abc].ts', 'd.ts')).toBe(true);
    expect(matchesGlob('[!abc].ts', 'a.ts')).toBe(false);
  });

  it('supports brace alternation', () => {
    expect(matchesGlob('**/*.{ts,tsx}', 'src/a.ts')).toBe(true);
    expect(matchesGlob('**/*.{ts,tsx}', 'src/a.tsx')).toBe(true);
    expect(matchesGlob('**/*.{ts,tsx}', 'src/a.js')).toBe(false);
  });

  it('escapes regex metacharacters in literal segments', () => {
    expect(matchesGlob('a+b.ts', 'a+b.ts')).toBe(true);
    expect(matchesGlob('a+b.ts', 'aab.ts')).toBe(false);
  });

  it('folds backslashes to forward slashes', () => {
    expect(matchesGlob('src/*.ts', 'src\\app.ts')).toBe(true);
  });

  it('matches any of several patterns', () => {
    expect(matchesAnyGlob(['*.md', '*.txt'], 'notes.txt')).toBe(true);
    expect(matchesAnyGlob(['*.md', '*.txt'], 'notes.rs')).toBe(false);
    expect(matchesAnyGlob([], 'notes.md')).toBe(false);
  });
});

describe('glob validation', () => {
  it('rejects an unbalanced brace', () => {
    expect(() => compileGlob('src/{a,b')).toThrow(ReviewError);
  });

  it('rejects a stray closing brace', () => {
    expect(() => compileGlob('src/a}')).toThrow(ReviewError);
  });

  it('rejects an unterminated character class', () => {
    expect(() => compileGlob('src/[abc')).toThrow(ReviewError);
  });
});
