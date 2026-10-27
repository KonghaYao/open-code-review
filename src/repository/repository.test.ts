// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EMPTY_TREE_SHA } from '../git/objects.js';
import { createReader, createRepository, type GitRepository } from './index.js';

const temporaryRoots: string[] = [];

function runGit(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      'git',
      [...args],
      { cwd, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', LANG: 'C' } },
      (error, stdout) => {
        if (error === null) {
          resolvePromise(stdout.trim());
        } else {
          reject(error);
        }
      },
    );
  });
}

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ocr-repository-'));
  temporaryRoots.push(dir);
  await runGit(dir, ['init', '-q', '-b', 'main']);
  await runGit(dir, ['config', 'user.email', 'review@example.com']);
  await runGit(dir, ['config', 'user.name', 'Review Test']);
  await runGit(dir, ['config', 'commit.gpgsign', 'false']);
  return dir;
}

async function writeFileAt(dir: string, path: string, content: string | Buffer): Promise<void> {
  const target = join(dir, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
}

async function commit(dir: string, message: string): Promise<void> {
  await runGit(dir, ['add', '-A']);
  await runGit(dir, ['commit', '-q', '-m', message]);
}

interface FixedFixture {
  dir: string;
  c1: string;
  c2: string;
  repo: GitRepository;
}

interface WorkspaceFixture {
  dir: string;
  head: string;
  repo: GitRepository;
}

let fixed: FixedFixture;
let workspace: WorkspaceFixture;

const RANGE_INPUT = { mode: 'range', from: 'main', to: 'feature' } as const;

beforeAll(async () => {
  const dir = await initRepo();
  await writeFileAt(dir, 'a.txt', 'one\ntwo\nthree\n');
  await writeFileAt(dir, 'c.txt', 'rename me\n');
  await writeFileAt(dir, 'e.txt', 'delete me\n');
  await writeFileAt(dir, 'dup.txt', 'hello\nmiddle\nhello\n');
  await writeFileAt(dir, 'blob.bin', Buffer.from([0, 1, 2, 3]));
  await writeFileAt(dir, '.env', 'TOKEN=do-not-leak\n');
  await commit(dir, 'base');
  const c1 = await runGit(dir, ['rev-parse', 'HEAD']);

  await runGit(dir, ['checkout', '-q', '-b', 'feature']);
  await writeFileAt(dir, 'a.txt', 'one\nTWO\nthree\n');
  await runGit(dir, ['mv', 'c.txt', 'd.txt']);
  await runGit(dir, ['rm', '-q', 'e.txt']);
  await writeFileAt(dir, 'b.txt', 'hello world\nsecond line\n');
  await commit(dir, 'feature');
  const c2 = await runGit(dir, ['rev-parse', 'HEAD']);

  fixed = { dir, c1, c2, repo: createRepository(dir) };

  const workspaceDir = await initRepo();
  await writeFileAt(workspaceDir, 'w.txt', 'base\n');
  await writeFileAt(workspaceDir, '.env', 'TOKEN=1\n');
  await commit(workspaceDir, 'base');
  const head = await runGit(workspaceDir, ['rev-parse', 'HEAD']);
  await writeFileAt(workspaceDir, 'w.txt', 'base\nmore\n');
  await writeFileAt(workspaceDir, 'u.txt', 'new file\n');
  await writeFileAt(workspaceDir, 'sub/nested.txt', 'nested\n');
  workspace = { dir: workspaceDir, head, repo: createRepository(workspaceDir) };
}, 60_000);

afterAll(async () => {
  await Promise.all(temporaryRoots.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('prepareCodeReview in range mode', () => {
  it('freezes the merge base and the head commit into the source', async () => {
    const output = await fixed.repo.prepareCodeReview({ input: RANGE_INPUT });

    expect(output.source.mode).toBe('range');
    expect(output.source.repoId).toBe(await fixed.repo.getRepoId());
    expect(output.source.baseSha).toBe(fixed.c1);
    expect(output.source.mergeBaseSha).toBe(fixed.c1);
    expect(output.source.headSha).toBe(fixed.c2);
    expect(output.source.comparison).toBe('merge-base');
    expect(output.source.requestedRefs).toEqual({ from: 'main', to: 'feature' });
    expect(output.scope).toEqual({ include: [], exclude: [], includeTests: true, includeDeleted: true });
    expect(output.manifestDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(output.reviewKey).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(output.totalUnits).toBe(output.units.length);
    expect(output.nextCursor).toBeUndefined();
  });

  it('plans modified, added, renamed and deleted files', async () => {
    const output = await fixed.repo.prepareCodeReview({ input: RANGE_INPUT });
    const paths = new Set(output.units.flatMap((unit) => unit.paths));

    expect(output.excluded).toEqual([]);
    expect(paths).toEqual(new Set(['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt']));
    expect(output.units.some((unit) => unit.kind === 'cross_file')).toBe(true);
    expect(output.units.every((unit) => unit.status === 'pending')).toBe(true);
    expect([...paths].some((path) => path === 'dup.txt')).toBe(false);
  });

  it('is deterministic across repeated runs', async () => {
    const first = await fixed.repo.prepareCodeReview({ input: RANGE_INPUT });
    const second = await fixed.repo.prepareCodeReview({ input: RANGE_INPUT });

    expect(second.manifestDigest).toBe(first.manifestDigest);
    expect(second.reviewKey).toBe(first.reviewKey);
    expect(second.units.map((unit) => unit.unitId)).toEqual(first.units.map((unit) => unit.unitId));
  });

  it('rejects an unknown ref', async () => {
    await expect(fixed.repo.prepareCodeReview({ input: { mode: 'range', from: 'main', to: 'nope' } })).rejects.toMatchObject(
      { code: 'PREPARATION_FAILED' },
    );
  });

  it('rejects refs that belong to another mode', async () => {
    await expect(
      fixed.repo.prepareCodeReview({ input: { mode: 'range', from: 'main', to: 'feature', commit: 'HEAD' } }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('rejects an invalid scope glob', async () => {
    await expect(
      fixed.repo.prepareCodeReview({ input: RANGE_INPUT, scope: { exclude: ['src/{a'] } }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('prepareCodeReview in commit mode', () => {
  it('diffs a root commit against the empty tree and excludes secrets and binaries', async () => {
    const output = await fixed.repo.prepareCodeReview({ input: { mode: 'commit', commit: fixed.c1 } });

    expect(output.source.baseSha).toBe(EMPTY_TREE_SHA);
    expect(output.source.headSha).toBe(fixed.c1);
    expect(output.source.comparison).toBe('first-parent');
    const paths = output.units.flatMap((unit) => unit.paths);
    expect(paths).toEqual(expect.arrayContaining(['a.txt', 'c.txt', 'dup.txt', 'e.txt']));
    expect(paths).not.toContain('.env');
    expect(paths).not.toContain('blob.bin');

    const excluded = new Map(output.excluded.map((entry) => [entry.path, entry.reason]));
    expect(excluded.get('.env')).toBe('secret_path');
    expect(excluded.get('blob.bin')).toBe('binary');

    const rebuilt = await fixed.repo.rebuildManifest(output.source, undefined);
    expect(rebuilt.manifestDigest).toBe(output.manifestDigest);
  });
});

describe('pagination', () => {
  it('walks the manifest with a cursor that is bound to the input', async () => {
    const paged = createRepository(fixed.dir, { pageSize: 2 });
    const input = { mode: 'range' as const, from: 'main', to: 'feature' };
    const first = await paged.prepareCodeReview({ input });

    expect(first.totalUnits).toBe(5);
    expect(first.units).toHaveLength(2);
    expect(first.nextCursor).toBeDefined();

    const unitIds = first.units.map((unit) => unit.unitId);
    let cursor = first.nextCursor;
    let pages = 1;
    while (cursor !== undefined) {
      const page = await paged.prepareCodeReview({ input, cursor });
      expect(page.manifestDigest).toBe(first.manifestDigest);
      unitIds.push(...page.units.map((unit) => unit.unitId));
      cursor = page.nextCursor;
      pages += 1;
    }

    expect(pages).toBeGreaterThan(1);
    expect(unitIds).toHaveLength(first.totalUnits);
    expect(new Set(unitIds).size).toBe(unitIds.length);
  });

  it('rejects a cursor from another review input', async () => {
    const paged = createRepository(fixed.dir, { pageSize: 2 });
    const first = await paged.prepareCodeReview({ input: RANGE_INPUT });

    await expect(
      paged.prepareCodeReview({ input: { mode: 'commit', commit: fixed.c1 }, cursor: first.nextCursor }),
    ).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
  });
});

describe('rebuildManifest', () => {
  it('reproduces the digest from the fixed source', async () => {
    const output = await fixed.repo.prepareCodeReview({ input: RANGE_INPUT });
    const rebuilt = await fixed.repo.rebuildManifest(output.source, undefined);

    expect(rebuilt.manifestDigest).toBe(output.manifestDigest);
    expect(rebuilt.reviewKey).toBe(output.reviewKey);
    expect(rebuilt.units).toEqual(output.units);
  });

  it('changes the digest when the scope changes', async () => {
    const output = await fixed.repo.prepareCodeReview({ input: RANGE_INPUT });
    const narrowed = await fixed.repo.rebuildManifest(output.source, { exclude: ['b.txt'] });

    expect(narrowed.manifestDigest).not.toBe(output.manifestDigest);
    expect(narrowed.excluded.map((entry) => entry.path)).toContain('b.txt');
  });

  it('rejects a source from another repository and a mismatched input', async () => {
    const output = await fixed.repo.prepareCodeReview({ input: RANGE_INPUT });

    await expect(
      fixed.repo.rebuildManifest({ ...output.source, repoId: 'repo_other' }, undefined),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      fixed.repo.rebuildManifest(output.source, undefined, { mode: 'commit', commit: fixed.c2 }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

describe('verifyLocation', () => {
  async function rangeSource() {
    return (await fixed.repo.prepareCodeReview({ input: RANGE_INPUT })).source;
  }

  it('accepts a snippet at the claimed lines', async () => {
    const source = await rangeSource();
    const result = await fixed.repo.verifyLocation(source, {
      path: 'b.txt',
      side: 'head',
      startLine: 1,
      endLine: 1,
      snippet: 'hello world',
    });

    expect(result).toMatchObject({ located: true, side: 'head', startLine: 1, endLine: 1 });
    expect(result.digest).toMatch(/^sha256:/u);
  });

  it('relocates a unique snippet when the line numbers are wrong', async () => {
    const source = await rangeSource();
    const result = await fixed.repo.verifyLocation(source, {
      path: 'b.txt',
      side: 'head',
      startLine: 99,
      endLine: 99,
      snippet: 'second line',
    });

    expect(result).toMatchObject({ located: true, startLine: 2, endLine: 2 });
  });

  it('refuses to guess an ambiguous snippet', async () => {
    const source = await rangeSource();
    const result = await fixed.repo.verifyLocation(source, {
      path: 'dup.txt',
      side: 'head',
      startLine: 0,
      endLine: 0,
      snippet: 'hello',
    });

    expect(result.located).toBe(false);
    expect(result.note).toContain('2 places');
  });

  it('resolves a deleted file only on the base side', async () => {
    const source = await rangeSource();
    const location = { path: 'e.txt', side: 'head' as const, startLine: 1, endLine: 1, snippet: 'delete me' };

    expect((await fixed.repo.verifyLocation(source, location)).located).toBe(false);
    expect(await fixed.repo.verifyLocation(source, { ...location, side: 'base' })).toMatchObject({
      located: true,
      startLine: 1,
      endLine: 1,
    });
  });

  it('rejects secret and provider paths', async () => {
    const source = await rangeSource();
    const location = { side: 'base' as const, startLine: 1, endLine: 1, snippet: 'TOKEN' };

    await expect(fixed.repo.verifyLocation(source, { ...location, path: '.env' })).rejects.toMatchObject({
      code: 'INVALID_FINDING',
    });
    await expect(
      fixed.repo.verifyLocation(source, { ...location, path: 'node_modules/pkg/index.js' }),
    ).rejects.toMatchObject({ code: 'INVALID_FINDING' });
  });
});

describe('reader', () => {
  async function rangeSource() {
    return (await fixed.repo.prepareCodeReview({ input: RANGE_INPUT })).source;
  }

  it('reads a fixed side from git objects', async () => {
    const source = await rangeSource();
    const reader = createReader(fixed.repo);
    const file = await reader.readFile({ source, path: 'b.txt', side: 'head' });

    expect(file.text).toBe('hello world\nsecond line\n');
    expect(file.bytes).toBe(Buffer.byteLength('hello world\nsecond line\n'));
    expect(file.binary).toBe(false);
    expect(file.truncated).toBe(false);
    expect(file.digest).toMatch(/^sha256:/u);
  });

  it('reads a line range clamped to the file', async () => {
    const source = await rangeSource();
    const reader = createReader(fixed.repo);
    const lines = await reader.readLines({ source, path: 'b.txt', side: 'head', startLine: 2, endLine: 2 });

    expect(lines).toMatchObject({ path: 'b.txt', side: 'head', startLine: 2, endLine: 2, text: 'second line' });
  });

  it('searches case-insensitively and honours path filters', async () => {
    const source = await rangeSource();
    const reader = createReader(fixed.repo);
    const all = await reader.search({ source, side: 'head', query: 'HELLO' });

    expect(all.matches).toEqual(
      expect.arrayContaining([{ path: 'b.txt', line: 1, text: 'hello world' }]),
    );
    expect(all.skippedFiles).toContain('blob.bin');

    const narrowed = await reader.search({ source, side: 'head', query: 'hello', paths: ['a.txt'] });
    expect(narrowed.matches).toEqual([]);
  });

  it('reports binary files instead of decoding them', async () => {
    const source = await rangeSource();
    const reader = createReader(fixed.repo);
    const file = await reader.readFile({ source, path: 'blob.bin', side: 'head' });

    expect(file.binary).toBe(true);
    expect(file.text).toBe('');
    expect(file.bytes).toBe(4);
    await expect(
      reader.readLines({ source, path: 'blob.bin', side: 'head', startLine: 1, endLine: 1 }),
    ).rejects.toMatchObject({ code: 'BINARY_FILE' });
  });

  it('rejects secret paths and missing sides', async () => {
    const source = await rangeSource();
    const reader = createReader(fixed.repo);

    await expect(reader.readFile({ source, path: '.env', side: 'base' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect((await reader.readFile({ source, path: 'e.txt', side: 'base' })).text).toBe('delete me\n');
    await expect(reader.readFile({ source, path: 'e.txt', side: 'head' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(reader.readFile({ source, path: 'a.txt', side: 'workspace' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('returns undefined fingerprints for fixed sources', async () => {
    const source = await rangeSource();
    expect(await fixed.repo.currentFingerprint(source)).toBeUndefined();
  });
});

describe('workspace mode', () => {
  it('reads the live worktree and records a fingerprint', async () => {
    const output = await workspace.repo.prepareCodeReview({ input: { mode: 'workspace' } });

    expect(output.source.mode).toBe('workspace');
    expect(output.source.baseSha).toBe(workspace.head);
    expect(output.source.headSha).toBe(workspace.head);
    expect(output.source.comparison).toBe('workspace-vs-head');
    expect(output.source.workspaceFingerprint).toBeTruthy();
    const paths = output.units.flatMap((unit) => unit.paths);
    expect(paths).toEqual(expect.arrayContaining(['w.txt', 'u.txt', 'sub/nested.txt']));
    expect(await workspace.repo.currentFingerprint(output.source)).toBe(output.source.workspaceFingerprint);
  });

  it('reads workspace content from the live file', async () => {
    const output = await workspace.repo.prepareCodeReview({ input: { mode: 'workspace' } });
    const reader = createReader(workspace.repo);
    const file = await reader.readFile({ source: output.source, path: 'u.txt', side: 'workspace' });

    expect(file.text).toBe('new file\n');
    expect(file.side).toBe('workspace');
  });

  it('detects drift and refuses to reuse the resolved source', async () => {
    const output = await workspace.repo.prepareCodeReview({ input: { mode: 'workspace' } });
    const source = output.source;

    await writeFileAt(workspace.dir, 'u.txt', 'new file changed\n');

    expect(await workspace.repo.currentFingerprint(source)).not.toBe(source.workspaceFingerprint);
    await expect(workspace.repo.rebuildManifest(source, undefined)).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
    await expect(
      workspace.repo.verifyLocation(source, {
        path: 'u.txt',
        side: 'workspace',
        startLine: 1,
        endLine: 1,
        snippet: 'new file',
      }),
    ).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });

    const refreshed = await workspace.repo.prepareCodeReview({ input: { mode: 'workspace' } });
    expect(refreshed.source.workspaceFingerprint).not.toBe(source.workspaceFingerprint);
  });
});
