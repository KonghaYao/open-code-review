// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
import { describe, expect, it } from 'vitest';

import { buildAddDiff, buildBinaryAddDiff, parseUnifiedDiff, quoteGitPath, unquoteGitPath } from './diff.js';

const LIMIT = 4 * 1024 * 1024;

describe('parseUnifiedDiff', () => {
  it('parses an added file as a head-only block', () => {
    const blocks = parseUnifiedDiff(
      [
        'diff --git a/new.txt b/new.txt',
        'new file mode 100644',
        'index 0000000..e69de29',
        '--- /dev/null',
        '+++ b/new.txt',
        '@@ -0,0 +1,2 @@',
        '+one',
        '+two',
        '',
      ].join('\n'),
      LIMIT,
    );

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.status).toBe('added');
    expect(blocks[0]?.oldPath).toBe('');
    expect(blocks[0]?.newPath).toBe('new.txt');
    expect(blocks[0]?.insertions).toBe(2);
    expect(blocks[0]?.deletions).toBe(0);
    expect(blocks[0]?.hunks).toHaveLength(1);
    expect(blocks[0]?.hunks[0]?.header).toBe('@@ -0,0 +1,2 @@');
    expect(blocks[0]?.hunks[0]?.lines).toEqual(['+one', '+two']);
  });

  it('parses a deleted file as a base-only block', () => {
    const blocks = parseUnifiedDiff(
      [
        'diff --git a/gone.txt b/gone.txt',
        'deleted file mode 100644',
        '--- a/gone.txt',
        '+++ /dev/null',
        '@@ -1 +0,0 @@',
        '-only',
      ].join('\n'),
      LIMIT,
    );

    expect(blocks[0]?.status).toBe('deleted');
    expect(blocks[0]?.oldPath).toBe('gone.txt');
    expect(blocks[0]?.newPath).toBe('');
    expect(blocks[0]?.deletions).toBe(1);
  });

  it('keeps both paths of a rename and reports no hunks for a pure rename', () => {
    const blocks = parseUnifiedDiff(
      [
        'diff --git a/old.txt b/new.txt',
        'similarity index 100%',
        'rename from old.txt',
        'rename to new.txt',
      ].join('\n'),
      LIMIT,
    );

    expect(blocks[0]?.status).toBe('renamed');
    expect(blocks[0]?.oldPath).toBe('old.txt');
    expect(blocks[0]?.newPath).toBe('new.txt');
    expect(blocks[0]?.hunks).toHaveLength(0);
  });

  it('parses a copy', () => {
    const blocks = parseUnifiedDiff(
      ['diff --git a/orig.txt b/copy.txt', 'similarity index 100%', 'copy from orig.txt', 'copy to copy.txt'].join('\n'),
      LIMIT,
    );

    expect(blocks[0]?.status).toBe('copied');
    expect(blocks[0]?.oldPath).toBe('orig.txt');
    expect(blocks[0]?.newPath).toBe('copy.txt');
  });

  it('flags binary blocks and still records their paths', () => {
    const blocks = parseUnifiedDiff(
      ['diff --git a/blob.bin b/blob.bin', 'index 1111111..2222222 100644', 'Binary files a/blob.bin and b/blob.bin differ'].join(
        '\n',
      ),
      LIMIT,
    );

    expect(blocks[0]?.binary).toBe(true);
    expect(blocks[0]?.status).toBe('modified');
    expect(blocks[0]?.oldPath).toBe('blob.bin');
    expect(blocks[0]?.newPath).toBe('blob.bin');
    expect(blocks[0]?.hunks).toHaveLength(0);
  });

  it('decodes quoted paths with octal byte escapes', () => {
    const blocks = parseUnifiedDiff(
      [
        'diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"',
        'index 1111111..2222222 100644',
        '--- "a/caf\\303\\251.txt"',
        '+++ "b/caf\\303\\251.txt"',
        '@@ -1 +1 @@',
        '-before',
        '+after',
      ].join('\n'),
      LIMIT,
    );

    expect(blocks[0]?.oldPath).toBe('caf\u00e9.txt');
    expect(blocks[0]?.newPath).toBe('caf\u00e9.txt');
  });

  it('drops the no-newline marker so line counters stay aligned', () => {
    const blocks = parseUnifiedDiff(
      [
        'diff --git a/a.txt b/a.txt',
        '--- a/a.txt',
        '+++ b/a.txt',
        '@@ -1,2 +1,2 @@',
        ' keep',
        '-old',
        '+new',
        '\\ No newline at end of file',
      ].join('\n'),
      LIMIT,
    );

    expect(blocks[0]?.hunks[0]?.lines).toEqual([' keep', '-old', '+new']);
    expect(blocks[0]?.insertions).toBe(1);
    expect(blocks[0]?.deletions).toBe(1);
  });

  it('reads the default hunk counts when they are omitted', () => {
    const blocks = parseUnifiedDiff(
      ['diff --git a/a.txt b/a.txt', '--- a/a.txt', '+++ b/a.txt', '@@ -7 +8 @@', '-x', '+y'].join('\n'),
      LIMIT,
    );

    expect(blocks[0]?.hunks[0]).toMatchObject({ oldStart: 7, oldCount: 1, newStart: 8, newCount: 1 });
  });

  it('splits multiple files and ignores text before the first header', () => {
    const blocks = parseUnifiedDiff(
      [
        'warning: something',
        'diff --git a/a.txt b/a.txt',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/a.txt',
        '@@ -0,0 +1 @@',
        '+a',
        'diff --git a/b.txt b/b.txt',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/b.txt',
        '@@ -0,0 +1 @@',
        '+b',
      ].join('\n'),
      LIMIT,
    );

    expect(blocks.map((block) => block.newPath)).toEqual(['a.txt', 'b.txt']);
  });

  it('truncates an oversized block on a line boundary instead of dropping it', () => {
    const body = Array.from({ length: 50 }, (_, index) => `+line ${index}`).join('\n');
    const blocks = parseUnifiedDiff(
      ['diff --git a/big.txt b/big.txt', 'new file mode 100644', '--- /dev/null', '+++ b/big.txt', '@@ -0,0 +1,50 @@', body].join(
        '\n',
      ),
      120,
    );

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.truncated).toBe(true);
    expect(blocks[0]?.text.length).toBeLessThan(200);
    expect(blocks[0]?.text.startsWith('diff --git a/big.txt b/big.txt')).toBe(true);
    expect(blocks[0]?.text).not.toContain('+line 49');
  });

  it('does not truncate when the limit is disabled', () => {
    const blocks = parseUnifiedDiff(
      ['diff --git a/a.txt b/a.txt', 'new file mode 100644', '--- /dev/null', '+++ b/a.txt', '@@ -0,0 +1 @@', '+a'].join('\n'),
      0,
    );

    expect(blocks[0]?.truncated).toBe(false);
  });
});

describe('buildAddDiff', () => {
  it('builds a diff that parses back into an added block', () => {
    const diff = buildAddDiff('src/app.ts', Buffer.from('export const a = 1;\n'));
    const blocks = parseUnifiedDiff(diff, LIMIT);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.status).toBe('added');
    expect(blocks[0]?.newPath).toBe('src/app.ts');
    expect(blocks[0]?.insertions).toBe(1);
  });

  it('terminates a file without a trailing newline correctly', () => {
    const blocks = parseUnifiedDiff(buildAddDiff('a.txt', Buffer.from('no-newline')), LIMIT);

    expect(blocks[0]?.hunks[0]?.lines).toEqual(['+no-newline']);
  });

  it('builds a binary marker that parses as a binary add', () => {
    const blocks = parseUnifiedDiff(buildBinaryAddDiff('image.bin'), LIMIT);

    expect(blocks[0]?.binary).toBe(true);
    expect(blocks[0]?.status).toBe('added');
    expect(blocks[0]?.newPath).toBe('image.bin');
  });
});

describe('git path quoting', () => {
  it('round-trips paths that need quoting', () => {
    const path = 'dir/odd"name.txt';
    const quoted = quoteGitPath(path);
    expect(quoted.startsWith('"')).toBe(true);
    expect(unquoteGitPath(quoted)).toEqual({ path, rest: '' });
  });

  it('leaves ordinary paths unquoted', () => {
    expect(quoteGitPath('dir/plain name.txt')).toBe('dir/plain name.txt');
    expect(unquoteGitPath('plain.txt')).toBeUndefined();
  });

  it('returns undefined for an unterminated quoted path', () => {
    expect(unquoteGitPath('"broken')).toBeUndefined();
  });
});
