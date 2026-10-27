// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
import { describe, expect, it } from 'vitest';

import type { ReviewUnit } from '../domain/types.js';
import { parseSystemRuleCatalog, type SystemRuleCatalog } from './catalog.js';
import {
  FALLBACK_RULE_ID,
  buildProjectChecks,
  buildUnitReviewArea,
  checkIdFor,
  projectCheckTexts,
  unitChangeKind,
} from './match.js';
import { parseProjectRules } from './project.js';

function catalog(): SystemRuleCatalog {
  return parseSystemRuleCatalog({
    formatVersion: 1,
    version: 'test',
    fallback: { area: 'general', checks: ['fallback check'] },
    rules: [
      { id: 'code', area: 'correctness', languages: ['typescript'], checks: ['code check'] },
      { id: 'config', area: 'security', pathCategories: ['config'], checks: ['config check'] },
      { id: 'tests', area: 'testing', pathCategories: ['test'], checks: ['test check'] },
      { id: 'deleted', area: 'correctness', changeKinds: ['deleted'], checks: ['deleted check'] },
      { id: 'migrations', area: 'correctness', patterns: ['**/migrations/**'], checks: ['migration check'] },
      { id: 'cross', area: 'cross-file', appliesTo: 'cross_file', checks: ['cross check'] },
      { id: 'file-only', area: 'maintainability', appliesTo: 'file', languages: ['typescript'], checks: ['file check'] },
    ],
  });
}

function unit(overrides: Partial<ReviewUnit> = {}): ReviewUnit {
  return {
    unitId: 'u_1',
    kind: 'file',
    changeIds: ['ch_1'],
    paths: ['src/app.ts'],
    relatedPaths: [],
    side: 'head',
    startLine: 1,
    endLine: 2,
    slices: [],
    fullFile: false,
    ruleRefs: [],
    status: 'pending',
    ...overrides,
  };
}

function build(target: ReviewUnit, projectText?: string) {
  return buildUnitReviewArea({
    unit: target,
    catalog: catalog(),
    project: projectText === undefined ? undefined : parseProjectRules(projectText),
    rulesDigest: 'sha256:test',
  });
}

describe('unit rule matching', () => {
  it('returns every matching system rule for a source file', () => {
    const area = build(unit());

    expect(area.unitId).toBe('u_1');
    expect(area.areas).toEqual(['correctness', 'maintainability']);
    expect(area.ruleIds).toEqual(['system:code', 'system:file-only']);
    expect(area.checks.map((check) => check.text)).toEqual(['code check', 'file check']);
    expect(area.rulesDigest).toBe('sha256:test');
    expect(area.fallback).toBeUndefined();
  });

  it('matches rules by path category', () => {
    expect(build(unit({ paths: ['config/app.yaml'] })).areas).toEqual(['security']);
    expect(build(unit({ paths: ['src/app.test.ts'] })).areas).toEqual(['correctness', 'maintainability', 'testing']);
  });

  it('matches rules by path pattern case-insensitively', () => {
    const lower = build(unit({ paths: ['db/migrations/001.sql'] }));
    const upper = build(unit({ paths: ['DB/Migrations/002.SQL'] }));

    expect(lower.checks.map((check) => check.text)).toContain('migration check');
    expect(upper.checks.map((check) => check.text)).toContain('migration check');
    expect(lower.ruleIds).toContain('system:migrations');
  });

  it('returns generic checks with a fallback marker when nothing matches', () => {
    const area = build(unit({ paths: ['assets/logo.bin'] }));

    expect(area.fallback).toBe(true);
    expect(area.areas).toEqual(['general']);
    expect(area.ruleIds).toEqual([FALLBACK_RULE_ID]);
    expect(area.checks).toHaveLength(1);
    expect(area.checks[0]?.ruleId).toBe(FALLBACK_RULE_ID);
    expect(area.checks[0]?.checkId).toMatch(/^chk_[0-9a-f]{16}$/u);
  });

  it('marks a base-side file unit as deleted', () => {
    expect(unitChangeKind(unit({ side: 'base' }))).toBe('deleted');
    expect(unitChangeKind(unit({ side: 'head' }))).toBe('modified');
    expect(unitChangeKind(unit({ kind: 'cross_file', side: 'base' }))).toBe('modified');

    const area = build(unit({ side: 'base' }));
    expect(area.checks.map((check) => check.text)).toContain('deleted check');
    expect(area.areas).toEqual(['correctness', 'maintainability']);
  });

  it('adds the fixed cross-file checks and excludes file-only rules', () => {
    const area = build(unit({ kind: 'cross_file', paths: ['src/app.ts', 'src/app.test.ts'] }));

    expect(area.areas).toEqual(['correctness', 'testing', 'cross-file']);
    expect(area.ruleIds).toContain('system:cross');
    expect(area.ruleIds).not.toContain('system:file-only');
    expect(area.checks.map((check) => check.text)).toContain('cross check');
  });

  it('deduplicates checks when a unit carries several paths', () => {
    const area = build(unit({ paths: ['src/a.ts', 'src/b.ts'] }));

    expect(area.checks.map((check) => check.checkId)).toHaveLength(2);
    expect(area.ruleIds).toEqual(['system:code', 'system:file-only']);
  });

  it('falls back when no path is supplied', () => {
    const area = build(unit({ paths: [] }));

    expect(area.fallback).toBe(true);
  });

  it('produces stable check ids independent of the unit', () => {
    const first = build(unit({ unitId: 'u_1' }));
    const second = build(unit({ unitId: 'u_2', paths: ['src/other.ts'] }));

    expect(first.checks.map((check) => check.checkId)).toEqual(second.checks.map((check) => check.checkId));
    expect(checkIdFor('system:code', 'code check')).toBe(first.checks[0]?.checkId);
    expect(first.checks[0]?.checkId).not.toBe(checkIdFor('system:other', 'code check'));
  });
});

describe('project rule matching', () => {
  it('replaces system checks when merge_system_rule is false', () => {
    const area = build(unit(), JSON.stringify({ rules: [{ path: '**/*.ts', rule: 'First project rule.\n\nSecond project rule.' }] }));

    expect(area.areas).toEqual(['project']);
    expect(area.ruleIds).toEqual(['project:**/*.ts']);
    expect(area.checks.map((check) => check.text)).toEqual(['First project rule.', 'Second project rule.']);
    expect(area.fallback).toBeUndefined();
  });

  it('keeps system checks when merge_system_rule is true', () => {
    const area = build(
      unit(),
      JSON.stringify({ rules: [{ path: '**/*.ts', rule: 'Project rule.', merge_system_rule: true }] }),
    );

    expect(area.areas).toEqual(['correctness', 'maintainability', 'project']);
    expect(area.ruleIds).toEqual(['project:**/*.ts', 'system:code', 'system:file-only']);
    expect(area.checks.map((check) => check.text)).toEqual(['code check', 'file check', 'Project rule.']);
  });

  it('skips disabled project entries and keeps system rules', () => {
    const area = build(unit(), JSON.stringify({ rules: [{ path: '**/*.ts', rule: '' }] }));

    expect(area.areas).toEqual(['correctness', 'maintainability']);
    expect(area.ruleIds).not.toContain('project:**/*.ts');
  });

  it('applies project include and exclude filters', () => {
    const included = JSON.stringify({
      rules: [{ path: '**/*.ts', rule: 'Project rule.' }],
      include: ['src/**'],
    });
    expect(build(unit({ paths: ['tools/app.ts'] }), included).areas).toEqual(['correctness', 'maintainability']);
    expect(build(unit({ paths: ['src/app.ts'] }), included).areas).toEqual(['project']);

    const excluded = JSON.stringify({
      rules: [{ path: '**/*.ts', rule: 'Project rule.' }],
      exclude: ['src/generated/**'],
    });
    expect(build(unit({ paths: ['src/app.ts'] }), excluded).areas).toEqual(['project']);
    expect(build(unit({ paths: ['src/generated/client.ts'] }), excluded).areas).toEqual([
      'correctness',
      'maintainability',
    ]);
  });

  it('splits project text into stable paragraph checks', () => {
    expect(projectCheckTexts('One.\r\n\r\n  Two.  \r\n\r\n')).toEqual(['One.', 'Two.']);
    const entry = { index: 0, path: '**/*.ts', rule: 'One.\n\nTwo.', mergeSystemRule: false };
    const checks = buildProjectChecks(entry);
    expect(checks.map((check) => check.checkId)).toEqual([
      checkIdFor('project:**/*.ts', 'One.'),
      checkIdFor('project:**/*.ts', 'Two.'),
    ]);
  });
});
