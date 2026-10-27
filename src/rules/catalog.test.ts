// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
import { describe, expect, it } from 'vitest';

import { ReviewError } from '../domain/errors.js';
import {
  SYSTEM_RULE_FORMAT_VERSION,
  computeRulesDigest,
  loadBundledSystemCatalog,
  parseSystemRuleCatalog,
} from './catalog.js';

function raw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    formatVersion: SYSTEM_RULE_FORMAT_VERSION,
    version: '1.0.0',
    fallback: { area: 'general', checks: ['fallback check'] },
    rules: [{ id: 'code', area: 'correctness', languages: ['typescript'], checks: ['code check'] }],
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

describe('system rule catalog', () => {
  it('loads the bundled catalog and covers all review categories', () => {
    const catalog = loadBundledSystemCatalog();

    expect(catalog.formatVersion).toBe(SYSTEM_RULE_FORMAT_VERSION);
    expect(catalog.version).not.toBe('');
    expect(catalog.fallback.checks.length).toBeGreaterThan(0);
    expect(catalog.rules.length).toBeGreaterThan(0);

    const areas = new Set(catalog.rules.map((rule) => rule.area));
    for (const category of ['correctness', 'security', 'performance', 'maintainability', 'testing', 'redundancy']) {
      expect(areas.has(category)).toBe(true);
    }
    expect(areas.has('cross-file')).toBe(true);
    expect(new Set(catalog.rules.map((rule) => rule.id)).size).toBe(catalog.rules.length);
  });

  it('produces a stable digest that ignores key order', () => {
    const left = parseSystemRuleCatalog(raw());
    const right = parseSystemRuleCatalog({
      rules: [{ checks: ['code check'], languages: ['typescript'], area: 'correctness', id: 'code' }],
      fallback: { checks: ['fallback check'], area: 'general' },
      version: '1.0.0',
      formatVersion: SYSTEM_RULE_FORMAT_VERSION,
    });

    expect(computeRulesDigest(left)).toBe(computeRulesDigest(right));
    expect(computeRulesDigest(left)).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it('changes the digest when a check changes', () => {
    const base = parseSystemRuleCatalog(raw());
    const changed = parseSystemRuleCatalog(
      raw({ rules: [{ id: 'code', area: 'correctness', languages: ['typescript'], checks: ['different check'] }] }),
    );

    expect(computeRulesDigest(base)).not.toBe(computeRulesDigest(changed));
  });

  it('normalizes selectors and removes duplicates', () => {
    const catalog = parseSystemRuleCatalog(
      raw({
        rules: [
          {
            id: 'code',
            area: 'correctness',
            languages: ['TypeScript', 'typescript'],
            patterns: ['**/*.TS', '**/*.ts'],
            changeKinds: ['modified', 'modified'],
            checks: ['same check', 'same check'],
          },
        ],
      }),
    );

    const rule = catalog.rules[0];
    expect(rule?.languages).toEqual(['typescript']);
    expect(rule?.patterns).toEqual(['**/*.ts']);
    expect(rule?.changeKinds).toEqual(['modified']);
    expect(rule?.checks).toEqual(['same check']);
  });

  it('rejects a wrong format version', () => {
    const error = failure(() => parseSystemRuleCatalog(raw({ formatVersion: 2 })));

    expect(error.code).toBe('PREPARATION_FAILED');
    expect(error.message).toContain('formatVersion');
  });

  it('rejects duplicate rule ids', () => {
    const error = failure(() =>
      parseSystemRuleCatalog(
        raw({
          rules: [
            { id: 'dup', area: 'correctness', languages: ['go'], checks: ['one'] },
            { id: 'dup', area: 'security', languages: ['go'], checks: ['two'] },
          ],
        }),
      ),
    );

    expect(error.message).toContain('duplicate rule id');
  });

  it('rejects a file rule without selectors', () => {
    const error = failure(() =>
      parseSystemRuleCatalog(raw({ rules: [{ id: 'all', area: 'correctness', checks: ['everything'] }] })),
    );

    expect(error.message).toContain('at least one selector');
  });

  it('allows a cross-file rule without selectors', () => {
    const catalog = parseSystemRuleCatalog(
      raw({ rules: [{ id: 'cross', area: 'cross-file', appliesTo: 'cross_file', checks: ['cross check'] }] }),
    );

    expect(catalog.rules[0]?.appliesTo).toBe('cross_file');
  });

  it('rejects the reserved fallback id', () => {
    const error = failure(() =>
      parseSystemRuleCatalog(raw({ rules: [{ id: 'fallback', area: 'correctness', languages: ['go'], checks: ['check'] }] })),
    );

    expect(error.message).toContain('reserved');
  });

  it('rejects an unsupported path category', () => {
    const error = failure(() =>
      parseSystemRuleCatalog(
        raw({ rules: [{ id: 'bad', area: 'correctness', pathCategories: ['sorcery'], checks: ['check'] }] }),
      ),
    );

    expect(error.message).toContain('pathCategories');
  });

  it('rejects an invalid glob', () => {
    const error = failure(() =>
      parseSystemRuleCatalog(raw({ rules: [{ id: 'bad', area: 'correctness', patterns: ['**/[abc'], checks: ['check'] }] })),
    );

    expect(error.message).toContain('invalid glob');
  });

  it('rejects empty checks and a missing fallback', () => {
    expect(failure(() => parseSystemRuleCatalog(raw({ rules: [{ id: 'bad', area: 'correctness', languages: ['go'], checks: [] }] }))).code).toBe(
      'PREPARATION_FAILED',
    );
    expect(failure(() => parseSystemRuleCatalog(raw({ fallback: undefined }))).code).toBe('PREPARATION_FAILED');
  });

  it('ignores unknown fields', () => {
    const catalog = parseSystemRuleCatalog(
      raw({ rules: [{ id: 'code', area: 'correctness', languages: ['typescript'], checks: ['check'], future: true }] }),
    );

    expect(catalog.rules[0]?.checks).toEqual(['check']);
  });
});
