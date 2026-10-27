// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ReviewError } from '../domain/errors.js';
import type { ReviewSource } from '../domain/types.js';
import {
  PROJECT_RULE_PATH,
  loadProjectRuleText,
  matchProjectEntry,
  parseProjectRules,
  projectRulesApply,
} from './project.js';

const GIT_ENV = { ...process.env, LC_ALL: 'C', LANG: 'C' };

function source(overrides: Partial<ReviewSource> = {}): ReviewSource {
  return {
    repoId: 'repo_test',
    mode: 'commit',
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    comparison: 'first-parent',
    ...overrides,
  };
}

function failure(run: () => unknown): ReviewError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ReviewError);
    return error as ReviewError;
  }
  throw new Error('expected the call to fail');
}

async function createRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ocr-rules-project-'));
  execFileSync('git', ['init', '-q'], { cwd: root, env: GIT_ENV });
  return root;
}

function commit(root: string): string {
  execFileSync('git', ['add', '-A'], { cwd: root, env: GIT_ENV });
  execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'test'],
    { cwd: root, env: GIT_ENV },
  );
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, env: GIT_ENV }).toString().trim();
}

async function writeProjectRule(root: string, value: unknown): Promise<void> {
  await mkdir(join(root, '.opencodereview'), { recursive: true });
  await writeFile(join(root, PROJECT_RULE_PATH), JSON.stringify(value), 'utf8');
}

describe('project rule parsing', () => {
  it('parses the documented schema', () => {
    const rules = parseProjectRules(
      JSON.stringify({
        rules: [{ path: '**/*.go', rule: 'Use errors.Is.', merge_system_rule: true }],
        include: ['src/**'],
        exclude: ['**/generated/**'],
      }),
    );

    expect(rules).toEqual({
      rules: [{ index: 0, path: '**/*.go', rule: 'Use errors.Is.', mergeSystemRule: true }],
      include: ['src/**'],
      exclude: ['**/generated/**'],
    });
  });

  it('treats an empty file or missing rules as an empty policy', () => {
    expect(parseProjectRules('   ')).toBeUndefined();
    expect(parseProjectRules('{}')).toEqual({ rules: [], include: [], exclude: [] });
    expect(parseProjectRules('{"rules": null}')).toEqual({ rules: [], include: [], exclude: [] });
  });

  it('cleans include and exclude lists', () => {
    const rules = parseProjectRules(JSON.stringify({ include: [' src/** ', '', 'docs/**'], exclude: ['  ', '**/vendor/**'] }));

    expect(rules?.include).toEqual(['src/**', 'docs/**']);
    expect(rules?.exclude).toEqual(['**/vendor/**']);
  });

  it('rejects invalid JSON, a non-object root and bad entry types', () => {
    expect(failure(() => parseProjectRules('{')).code).toBe('PREPARATION_FAILED');
    expect(failure(() => parseProjectRules('[]')).code).toBe('PREPARATION_FAILED');
    expect(failure(() => parseProjectRules(JSON.stringify({ rules: {} }))).code).toBe('PREPARATION_FAILED');
    expect(failure(() => parseProjectRules(JSON.stringify({ rules: [null] }))).code).toBe('PREPARATION_FAILED');
    expect(failure(() => parseProjectRules(JSON.stringify({ rules: [{ path: '' }] }))).code).toBe('PREPARATION_FAILED');
    expect(failure(() => parseProjectRules(JSON.stringify({ rules: [{ path: 'x', rule: 3 }] }))).code).toBe(
      'PREPARATION_FAILED',
    );
    expect(
      failure(() => parseProjectRules(JSON.stringify({ rules: [{ path: 'x', merge_system_rule: 'yes' }] }))).code,
    ).toBe('PREPARATION_FAILED');
  });

  it('rejects an invalid glob in a rule or filter', () => {
    expect(failure(() => parseProjectRules(JSON.stringify({ rules: [{ path: '**/[abc' }] }))).code).toBe(
      'PREPARATION_FAILED',
    );
    expect(failure(() => parseProjectRules(JSON.stringify({ include: ['**/[abc'] }))).code).toBe('PREPARATION_FAILED');
  });
});

describe('project rule matching', () => {
  it('uses first-match-wins and skips disabled entries', () => {
    const rules = parseProjectRules(
      JSON.stringify({
        rules: [
          { path: '**/*.ts', rule: '' },
          { path: '**/*.ts', rule: 'first' },
          { path: '**/*.ts', rule: 'second' },
        ],
      }),
    );

    expect(rules).toBeDefined();
    expect(matchProjectEntry(rules!, 'src/app.ts')?.rule).toBe('first');
  });

  it('matches case-insensitively and supports brace alternation', () => {
    const rules = parseProjectRules(JSON.stringify({ rules: [{ path: '**/*.{ts,tsx}', rule: 'typed code' }] }));

    expect(matchProjectEntry(rules!, 'SRC/App.TSX')?.rule).toBe('typed code');
  });

  it('requires include and respects exclude', () => {
    const rules = parseProjectRules(
      JSON.stringify({ rules: [{ path: '**/*.ts', rule: 'project' }], include: ['src/**'], exclude: ['**/generated/**'] }),
    );

    expect(projectRulesApply(rules!, 'src/app.ts')).toBe(true);
    expect(matchProjectEntry(rules!, 'src/app.ts')?.rule).toBe('project');
    expect(projectRulesApply(rules!, 'tools/app.ts')).toBe(false);
    expect(matchProjectEntry(rules!, 'tools/app.ts')).toBeUndefined();
    expect(matchProjectEntry(rules!, 'src/generated/client.ts')).toBeUndefined();
  });

  it('treats an empty project path as no match', () => {
    const rules = parseProjectRules(JSON.stringify({ rules: [{ path: '**/*.ts', rule: 'project' }] }));

    expect(matchProjectEntry(rules!, '')).toBeUndefined();
  });
});

describe('project rule loading', () => {
  it('reads the worktree in workspace mode', async () => {
    const root = await createRepo();
    try {
      await writeProjectRule(root, { rules: [{ path: '**/*.cs', rule: 'workspace rule' }] });
      const text = await loadProjectRuleText(source({ mode: 'workspace' }), { repoRoot: root });

      expect(parseProjectRules(text ?? '')?.rules[0]?.rule).toBe('workspace rule');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns undefined when the workspace has no rule file', async () => {
    const root = await createRepo();
    try {
      await expect(loadProjectRuleText(source({ mode: 'workspace' }), { repoRoot: root })).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a binary or oversized rule file', async () => {
    const root = await createRepo();
    try {
      await mkdir(join(root, '.opencodereview'), { recursive: true });
      await writeFile(join(root, PROJECT_RULE_PATH), Buffer.from([0x7b, 0x00, 0x7d]));
      await expect(loadProjectRuleText(source({ mode: 'workspace' }), { repoRoot: root })).rejects.toMatchObject({
        code: 'PREPARATION_FAILED',
      });

      await writeFile(join(root, PROJECT_RULE_PATH), '{"rules":[]}', 'utf8');
      await expect(
        loadProjectRuleText(source({ mode: 'workspace' }), { repoRoot: root, maxBytes: 4 }),
      ).rejects.toMatchObject({ code: 'PREPARATION_FAILED' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a rule path that is not a regular file', async () => {
    const root = await createRepo();
    try {
      await mkdir(join(root, PROJECT_RULE_PATH), { recursive: true });
      await expect(loadProjectRuleText(source({ mode: 'workspace' }), { repoRoot: root })).rejects.toMatchObject({
        code: 'PREPARATION_FAILED',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reads project rules from the fixed head tree, not the worktree', async () => {
    const root = await createRepo();
    try {
      await writeProjectRule(root, { rules: [{ path: '**/*.rb', rule: 'committed rule' }] });
      const head = commit(root);
      await writeProjectRule(root, { rules: [{ path: '**/*.rb', rule: 'uncommitted rule' }] });

      const text = await loadProjectRuleText(source({ mode: 'commit', headSha: head }), { repoRoot: root });

      expect(parseProjectRules(text ?? '')?.rules[0]?.rule).toBe('committed rule');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns undefined when the fixed head tree has no rule file', async () => {
    const root = await createRepo();
    try {
      await writeFile(join(root, 'README.md'), '# test\n', 'utf8');
      const head = commit(root);

      await expect(
        loadProjectRuleText(source({ mode: 'commit', headSha: head }), { repoRoot: root }),
      ).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails when the repository root is not a git repository', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ocr-rules-norepo-'));
    try {
      await expect(loadProjectRuleText(source(), { repoRoot: root })).rejects.toMatchObject({
        code: 'PREPARATION_FAILED',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uses an injected reader without touching git', async () => {
    const text = await loadProjectRuleText(source(), {
      repoRoot: '/does/not/exist',
      readProjectRule: async () => '{"rules":[]}',
    });

    expect(text).toBe('{"rules":[]}');
  });
});
