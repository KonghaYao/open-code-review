// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
import { describe, expect, it } from 'vitest';

import { ReviewError } from '../domain/errors.js';
import type { ReviewSource, ReviewUnit } from '../domain/types.js';
import { computeRulesDigest, parseSystemRuleCatalog, type SystemRuleCatalog } from './catalog.js';
import { CatalogRulesEngine, PlaceholderRulesEngine, createRulesEngine } from './index.js';

function catalog(): SystemRuleCatalog {
  return parseSystemRuleCatalog({
    formatVersion: 1,
    version: 'test',
    fallback: { area: 'general', checks: ['fallback check'] },
    rules: [{ id: 'code', area: 'correctness', languages: ['typescript'], checks: ['code check'] }],
  });
}

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

describe('createRulesEngine', () => {
  it('exposes the digest of the loaded system catalog', () => {
    const systemRules = catalog();
    const engine = createRulesEngine({ systemRules, readProjectRule: async () => undefined });

    expect(engine).toBeInstanceOf(CatalogRulesEngine);
    expect(engine.rulesDigest).toBe(computeRulesDigest(systemRules));
  });

  it('returns areas for the requested units in order', async () => {
    const engine = createRulesEngine({ systemRules: catalog(), readProjectRule: async () => undefined });
    const areas = await engine.getAreas(source(), [
      unit({ unitId: 'u_1' }),
      unit({ unitId: 'u_2', paths: ['assets/logo.bin'] }),
    ]);

    expect(areas.map((area) => area.unitId)).toEqual(['u_1', 'u_2']);
    expect(areas[0]?.areas).toEqual(['correctness']);
    expect(areas[1]?.fallback).toBe(true);
    expect(areas[0]?.rulesDigest).toBe(engine.rulesDigest);
  });

  it('applies project rules and caches them for the same source', async () => {
    const calls: string[] = [];
    const engine = createRulesEngine({
      systemRules: catalog(),
      readProjectRule: async (value) => {
        calls.push(value.headSha);
        return JSON.stringify({ rules: [{ path: '**/*.ts', rule: 'Project rule.' }] });
      },
    });

    const first = await engine.getAreas(source(), [unit()]);
    const second = await engine.getAreas(source(), [unit({ unitId: 'u_2' })]);
    expect(first[0]?.areas).toEqual(['project']);
    expect(second[0]?.areas).toEqual(['project']);
    expect(calls).toEqual(['b'.repeat(40)]);

    await engine.getAreas(source({ headSha: 'c'.repeat(40) }), [unit()]);
    expect(calls).toEqual(['b'.repeat(40), 'c'.repeat(40)]);
  });

  it('propagates project rule parsing errors', async () => {
    const engine = createRulesEngine({
      systemRules: catalog(),
      readProjectRule: async () => '{invalid',
    });

    await expect(engine.getAreas(source(), [unit()])).rejects.toMatchObject({ code: 'PREPARATION_FAILED' });
  });

  it('loads the bundled catalog and matches a TypeScript source file', async () => {
    const engine = createRulesEngine({ readProjectRule: async () => undefined });

    expect(engine.rulesDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    const areas = await engine.getAreas(source(), [unit()]);

    expect(areas[0]?.fallback).toBeUndefined();
    expect(areas[0]?.areas).toEqual([
      'correctness',
      'security',
      'performance',
      'maintainability',
      'testing',
      'redundancy',
    ]);
    expect(areas[0]?.checks.length).toBeGreaterThan(10);
  });

  it('keeps the scaffold export name working', () => {
    const engine = new PlaceholderRulesEngine({ systemRules: catalog(), readProjectRule: async () => undefined });

    expect(engine).toBeInstanceOf(CatalogRulesEngine);
  });

  it('reports the error class for an invalid catalog', () => {
    expect(() => parseSystemRuleCatalog({})).toThrowError(ReviewError);
  });
});
