// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
import { describe, expect, it } from 'vitest';

import { ReviewError } from '../domain/errors.js';
import {
  normalizeRepoPath,
  escapePathspec,
  isObjectId,
  isWithin,
  toFileSystemPath,
} from './paths.js';

describe('normalizeRepoPath', () => {
  it('makes a path repository-relative', () => {
    expect(normalizeRepoPath('./src/app.ts')).toBe('src/app.ts');
    expect(normalizeRepoPath('/src/app.ts')).toBe('src/app.ts');
    expect(normalizeRepoPath('src\\app.ts')).toBe('src/app.ts');
  });

  it('rejects paths that could escape the root', () => {
    expect(normalizeRepoPath('..')).toBe('');
    expect(normalizeRepoPath('src/../../etc/passwd')).toBe('');
    expect(normalizeRepoPath('')).toBe('');
    expect(normalizeRepoPath('.')).toBe('');
  });
});

describe('isObjectId', () => {
  it('accepts full sha1 and sha256 ids only', () => {
    expect(isObjectId('a'.repeat(40))).toBe(true);
    expect(isObjectId('0123456789abcdef'.repeat(4))).toBe(true);
    expect(isObjectId('a'.repeat(39))).toBe(false);
    expect(isObjectId('g'.repeat(40))).toBe(false);
  });
});

describe('pathspec helpers', () => {
  it('keeps glob characters literal', () => {
    expect(escapePathspec('docs/[draft].md')).toBe(':(literal)docs/[draft].md');
  });

  it('joins a normalized path onto the root', () => {
    expect(toFileSystemPath('/repo', './src/app.ts')).toBe('/repo/src/app.ts');
    expect(toFileSystemPath('/repo', '../escape')).toBeUndefined();
  });

  it('does not treat a sibling with a shared prefix as contained', () => {
    expect(isWithin('/repo', '/repo/src')).toBe(true);
    expect(isWithin('/repo', '/repo')).toBe(true);
    expect(isWithin('/repo', '/repository')).toBe(false);
    expect(isWithin('', '/repo')).toBe(false);
  });
});

describe('ReviewError', () => {
  it('serializes code and message', () => {
    const error = new ReviewError('INVALID_INPUT', 'bad input');
    expect(error.toJSON()).toEqual({ code: 'INVALID_INPUT', message: 'bad input' });
  });
});
