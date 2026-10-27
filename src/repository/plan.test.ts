// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
import { describe, expect, it } from 'vitest';

import type { DiffHunk } from '../git/diff.js';
import { changeIdFor, type ChangeRecord } from './changes.js';
import { MAX_CHANGED_LINES_PER_UNIT, planUnits } from './plan.js';
import { normalizeScope } from './scope.js';

function hunk(...lines: string[]): DiffHunk {
  const header = lines[0] ?? '@@ -1 +1 @@';
  return { oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, header, lines: lines.slice(1) };
}

function record(overrides: Partial<ChangeRecord> = {}): ChangeRecord {
  const oldPath = overrides.oldPath ?? 'src/app.ts';
  const newPath = overrides.newPath ?? oldPath;
  const status = overrides.status ?? (oldPath === '' ? 'added' : newPath === '' ? 'deleted' : 'modified');
  return {
    changeId: changeIdFor('range', status, oldPath, newPath),
    status,
    oldPath,
    newPath,
    source: 'range',
    binary: false,
    submodule: false,
    isTest: false,
    insertions: 1,
    deletions: 0,
    diff: '',
    diffTruncated: false,
    hunks: [hunk('@@ -1 +1,2 @@', ' base', '+added')],
    size: 10,
    ...overrides,
  };
}

describe('planUnits', () => {
  it('plans one bounded unit per hunk plus one cross-file unit', () => {
    const change = record();
    const plan = planUnits([change], { scope: normalizeScope() });

    expect(plan.excluded).toEqual([]);
    expect(plan.units).toHaveLength(2);
    const fileUnit = plan.units[0];
    expect(fileUnit?.kind).toBe('file');
    expect(fileUnit?.unitId).toMatch(/^u_[0-9a-f]+$/u);
    expect(fileUnit?.changeIds).toEqual([change.changeId]);
    expect(fileUnit?.paths).toEqual(['src/app.ts']);
    expect(fileUnit?.side).toBe('head');
    expect(fileUnit?.status).toBe('pending');
    expect(fileUnit?.slices).toEqual([{ hunkIndex: 0, start: 0, end: 2 }]);

    const crossUnit = plan.units[1];
    expect(crossUnit?.kind).toBe('cross_file');
    expect(crossUnit?.unitId).toMatch(/^u_cross_[0-9a-f]+$/u);
    expect(crossUnit?.paths).toEqual(['src/app.ts']);
  });

  it('marks a change without hunks as a whole-file unit', () => {
    const plan = planUnits([record({ hunks: [] })], { scope: normalizeScope() });

    expect(plan.units[0]?.fullFile).toBe(true);
    expect(plan.units[0]?.startLine).toBe(0);
  });

  it('hard-excludes secret paths even when explicitly included', () => {
    const plan = planUnits([record({ oldPath: '.env', newPath: '.env' })], {
      scope: normalizeScope({ include: ['.env'] }),
    });

    expect(plan.units).toHaveLength(0);
    expect(plan.excluded).toEqual([{ path: '.env', side: 'head', reason: 'secret_path', source: 'range' }]);
  });

  it('excludes provider directories unless the user includes them', () => {
    const change = record({ oldPath: 'node_modules/pkg/index.js', newPath: 'node_modules/pkg/index.js' });
    const excludedPlan = planUnits([change], { scope: normalizeScope() });
    expect(excludedPlan.excluded[0]?.reason).toBe('provider_directory');

    const includedPlan = planUnits([change], { scope: normalizeScope({ include: ['node_modules/**'] }) });
    expect(includedPlan.excluded).toEqual([]);
    expect(includedPlan.units[0]?.paths).toEqual(['node_modules/pkg/index.js']);
  });

  it('excludes tests and deleted files only when the scope asks for it', () => {
    const testChange = record({ oldPath: 'src/app.test.ts', newPath: 'src/app.test.ts' });
    expect(planUnits([testChange], { scope: normalizeScope() }).excluded).toEqual([]);
    expect(planUnits([testChange], { scope: normalizeScope({ includeTests: false }) }).excluded[0]?.reason).toBe(
      'tests_excluded',
    );

    const deleted = record({ oldPath: 'old.txt', newPath: '', status: 'deleted' });
    expect(planUnits([deleted], { scope: normalizeScope() }).units[0]?.side).toBe('base');
    expect(planUnits([deleted], { scope: normalizeScope({ includeDeleted: false }) }).excluded[0]?.reason).toBe(
      'deleted_excluded',
    );
  });

  it('applies user exclusion patterns and lets an include override them', () => {
    const change = record({ oldPath: 'docs/guide.md', newPath: 'docs/guide.md' });
    expect(planUnits([change], { scope: normalizeScope({ exclude: ['docs/**'] }) }).excluded[0]?.reason).toBe(
      'user_exclude',
    );
    expect(
      planUnits([change], { scope: normalizeScope({ include: ['docs/**'], exclude: ['docs/**'] }) }).excluded,
    ).toEqual([]);
  });

  it('excludes binary, submodule and oversized changes', () => {
    const binary = planUnits([record({ binary: true })], { scope: normalizeScope() });
    expect(binary.excluded[0]?.reason).toBe('binary');

    const submodule = planUnits([record({ submodule: true })], { scope: normalizeScope() });
    expect(submodule.excluded[0]?.reason).toBe('unsupported');

    const large = planUnits([record({ size: 500 })], { scope: normalizeScope(), maxFileBytes: 100 });
    expect(large.excluded[0]?.reason).toBe('too_large');
  });

  it('excludes a change whose effective path is empty', () => {
    const plan = planUnits([record({ oldPath: '', newPath: '', status: 'modified' })], { scope: normalizeScope() });

    expect(plan.excluded[0]?.reason).toBe('unsupported');
  });

  it('slices a long hunk at the changed-line limit with new-side line numbers', () => {
    const lines = Array.from({ length: MAX_CHANGED_LINES_PER_UNIT + 100 }, (_, index) => `+line ${index}`);
    const change = record({ hunks: [hunk(`@@ -0,0 +1,${lines.length} @@`, ...lines)] });
    const plan = planUnits([change], { scope: normalizeScope() });
    const fileUnits = plan.units.filter((unit) => unit.kind === 'file');

    expect(fileUnits).toHaveLength(2);
    expect(fileUnits[0]?.startLine).toBe(1);
    expect(fileUnits[0]?.endLine).toBe(MAX_CHANGED_LINES_PER_UNIT);
    expect(fileUnits[1]?.startLine).toBe(MAX_CHANGED_LINES_PER_UNIT + 1);
    expect(fileUnits[1]?.endLine).toBe(lines.length);
    expect(fileUnits[0]?.unitId).not.toBe(fileUnits[1]?.unitId);
  });

  it('keeps both paths of a rename and marks the old side as related', () => {
    const change = record({ oldPath: 'src/old.ts', newPath: 'src/new.ts', status: 'renamed' });
    const plan = planUnits([change], {
      scope: normalizeScope(),
      relatedPathsForPath: (path) => (path === 'src/new.ts' ? ['src/old.ts', 'src/shared.ts'] : []),
    });

    expect(plan.units[0]?.paths).toEqual(['src/new.ts', 'src/old.ts']);
    expect(plan.units[0]?.relatedPaths).toEqual(['src/shared.ts']);
    expect(plan.units[1]?.relatedPaths).toEqual(['src/shared.ts']);
  });

  it('collects rule refs from the planning hook without duplicates', () => {
    const plan = planUnits([record(), record({ oldPath: 'src/other.ts', newPath: 'src/other.ts' })], {
      scope: normalizeScope(),
      ruleRefsForPath: () => [{ source: 'system', pattern: 'security/**' }],
    });

    const crossUnit = plan.units[plan.units.length - 1];
    expect(crossUnit?.ruleRefs).toEqual([{ source: 'system', pattern: 'security/**' }]);
  });

  it('sorts and deduplicates excluded entries', () => {
    const plan = planUnits(
      [record({ binary: true, oldPath: 'b.txt', newPath: 'b.txt' }), record({ binary: true, oldPath: 'a.txt', newPath: 'a.txt' })],
      { scope: normalizeScope() },
    );

    expect(plan.excluded.map((entry) => entry.path)).toEqual(['a.txt', 'b.txt']);
  });
});
