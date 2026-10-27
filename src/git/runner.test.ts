// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { GIT_GLOBAL_ARGS, GitError, GitRunner, gitEnvironment } from './runner.js';

const posix = process.platform === 'win32' ? describe.skip : describe;

let dir = '';

async function script(name: string, body: string): Promise<string> {
  const file = join(dir, name);
  await writeFile(file, body, { mode: 0o755 });
  return file;
}

function errorOf(promise: Promise<unknown>): Promise<GitError> {
  return promise.then(
    () => {
      throw new Error('expected the command to fail');
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(GitError);
      return error as GitError;
    },
  );
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ocr-runner-'));
  await script(
    'fake-git',
    '#!/bin/sh\nprintf "%s\\n" "$@"\nprintf "LC_ALL=%s\\n" "$LC_ALL"\nprintf "PROMPT=%s\\n" "$GIT_TERMINAL_PROMPT"\n',
  );
  await script('slow-git', '#!/bin/sh\nsleep 5\n');
  await script('loud-git', '#!/bin/sh\ni=0\nwhile [ $i -lt 4096 ]; do printf x; i=$((i+1)); done\n');
  await script('failing-git', '#!/bin/sh\necho "fatal: nope" >&2\nexit 3\n');
  await script('delayed-git', '#!/bin/sh\nsleep 0.05\nprintf "%s" "$3"\n');
});

afterAll(async () => {
  if (dir !== '') {
    await rm(dir, { recursive: true, force: true });
  }
});

describe('gitEnvironment', () => {
  it('pins the locale, disables prompting and lock writes', () => {
    const env = gitEnvironment({ HOME: '/home/test' });

    expect(env.HOME).toBe('/home/test');
    expect(env.LC_ALL).toBe('C');
    expect(env.LANG).toBe('C');
    expect(env.GIT_OPTIONAL_LOCKS).toBe('0');
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.GIT_PAGER).toBe('cat');
  });

  it('keeps the global arguments before the caller arguments', () => {
    expect(GIT_GLOBAL_ARGS).toEqual(['-c', 'core.quotepath=false']);
  });
});

posix('GitRunner', () => {
  it('passes every argument literally and prepends the global flags', async () => {
    const runner = new GitRunner({ cwd: dir, gitPath: join(dir, 'fake-git') });
    const lines = (await runner.run(['rev-parse', '--verify', '$HOME; echo injected'])).trim().split('\n');

    expect(lines.slice(0, GIT_GLOBAL_ARGS.length)).toEqual([...GIT_GLOBAL_ARGS]);
    expect(lines[GIT_GLOBAL_ARGS.length]).toBe('rev-parse');
    expect(lines).toContain('$HOME; echo injected');
    expect(lines).toContain('LC_ALL=C');
    expect(lines).toContain('PROMPT=0');
  });

  it('returns stdout as a buffer when asked', async () => {
    const runner = new GitRunner({ cwd: dir, gitPath: join(dir, 'fake-git') });
    const output = await runner.runBuffer(['status']);

    expect(Buffer.isBuffer(output)).toBe(true);
    expect(output.toString('utf8')).toContain('status');
  });

  it('reports a non-zero exit with the command and stderr', async () => {
    const runner = new GitRunner({ cwd: dir, gitPath: join(dir, 'failing-git') });
    const error = await errorOf(runner.run([]));

    expect(error.kind).toBe('failed');
    expect(error.message).toBe('fatal: nope');
    expect(error.exitCode).toBe(3);
    expect(error.stderr).toContain('fatal: nope');
  });

  it('kills a command that exceeds the timeout', async () => {
    const runner = new GitRunner({ cwd: dir, gitPath: join(dir, 'slow-git'), timeoutMs: 100 });
    const error = await errorOf(runner.run([]));

    expect(error.kind).toBe('timeout');
    expect(error.message).toContain('timed out after 100ms');
  });

  it('fails instead of buffering an unbounded output', async () => {
    const runner = new GitRunner({ cwd: dir, gitPath: join(dir, 'loud-git'), maxBufferBytes: 64 });
    const error = await errorOf(runner.run([]));

    expect(error.kind).toBe('output-limit');
    expect(error.message).toContain('exceeded the output buffer limit');
  });

  it('serializes callers beyond the concurrency limit instead of failing', async () => {
    const runner = new GitRunner({ cwd: dir, gitPath: join(dir, 'delayed-git'), maxConcurrent: 1 });
    const [first, second] = await Promise.all([runner.run(['a']), runner.run(['b'])]);

    expect(first).toBe('a');
    expect(second).toBe('b');
  });
});
