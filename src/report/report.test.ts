// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
import { chmod, lstat, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ReviewError, isReviewError } from '../domain/errors.js';
import type { ReportBuildContext } from '../domain/interfaces.js';
import type {
  Candidate,
  ExportCodeReviewInput,
  ReviewRunResult,
  ReviewSource,
  ReviewUnit,
  UnitResult,
  VerificationResult,
} from '../domain/types.js';
import { digestBytes } from '../git/hash.js';
import { FileReportBuilder } from './index.js';

const BASE_SHA = '1111111111111111111111111111111111111111';
const HEAD_SHA = '2222222222222222222222222222222222222222';
const RUN_ID = 'run-1';
const GENERATED_AT = '2026-10-27T00:00:00.000Z';
const runningAsRoot = process.getuid?.() === 0;
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(prefix = 'ocr-report-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function source(): ReviewSource {
  return {
    repoId: 'repo-1',
    mode: 'range',
    requestedRefs: { from: 'main', to: 'feature' },
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    mergeBaseSha: BASE_SHA,
    comparison: 'merge-base',
  };
}

function unit(unitId: string, path: string): ReviewUnit {
  return {
    unitId,
    kind: 'file',
    changeIds: [`change-${unitId}`],
    paths: [path],
    relatedPaths: [],
    side: 'head',
    startLine: 1,
    endLine: 20,
    slices: [{ hunkIndex: 0, start: 1, end: 20 }],
    fullFile: false,
    ruleRefs: [{ source: 'system', pattern: '**/*.ts' }],
    status: 'pending',
  };
}

function candidate(): Candidate {
  return {
    candidateId: 'u1:c1',
    unitId: 'u1',
    category: 'correctness',
    priority: 'P1',
    title: 'Null dereference',
    trigger: 'when y is null',
    impact: 'crashes the request handler',
    location: { path: 'src/a.ts', side: 'head', startLine: 10, endLine: 12, snippet: 'const x = y.z;' },
    evidence: [{ path: 'src/b.ts', side: 'base', startLine: 1, endLine: 2, snippet: 'y = null;' }],
  };
}

function verification(): VerificationResult {
  return {
    candidateId: 'u1:c1',
    reviewKey: 'rk-1',
    verdict: 'confirmed',
    reason: 'the path is reachable',
    evidence: [{ path: 'src/a.ts', side: 'head', startLine: 10, endLine: 10, snippet: 'const x = y.z;' }],
  };
}

function unitResult(unitId: string, checked: string[], candidates: Candidate[]): UnitResult {
  return {
    unitId,
    reviewKey: 'rk-1',
    status: 'reviewed',
    checkedCheckIds: checked,
    notApplicable: [],
    candidates,
  };
}

function makeResult(): ReviewRunResult {
  const reviewInput = { mode: 'range' as const, from: 'main', to: 'feature' };
  return {
    formatVersion: 1,
    reviewKey: 'rk-1',
    input: reviewInput,
    manifest: {
      reviewKey: 'rk-1',
      input: reviewInput,
      source: source(),
      scope: { include: [], exclude: [], includeTests: true, includeDeleted: true },
      units: [unit('u1', 'src/a.ts'), unit('u2', 'src/c.ts')],
      excluded: [{ path: 'dist/bundle.js', reason: 'default_exclude' }],
      manifestDigest: 'sha256:manifest',
      totalUnits: 2,
      rulesDigest: 'sha256:rules',
      skillDigests: { 'review-verify': 'sha256:skill-2', 'review-code': 'sha256:skill-1' },
      serverVersion: '0.1.0',
    },
    areasByUnit: [
      {
        unitId: 'u1',
        areas: ['logic'],
        checks: [{ checkId: 'c1', ruleId: 'r1', text: 'check one' }],
        ruleIds: ['r1'],
        rulesDigest: 'sha256:rules',
      },
      {
        unitId: 'u2',
        areas: ['security'],
        checks: [{ checkId: 'c2', ruleId: 'r2', text: 'check two' }],
        ruleIds: ['r2'],
        rulesDigest: 'sha256:rules',
      },
    ],
    unitResults: [unitResult('u1', ['c1'], [candidate()]), unitResult('u2', ['c2'], [])],
    verificationResults: [verification()],
    attempts: [{ stage: 'review', attempt: 1, status: 'succeeded', unitId: 'u1' }],
    gaps: [],
    coverage: {
      required: 2,
      reviewed: 2,
      reused: 0,
      skipped: 0,
      failed: 0,
      pending: 0,
      complete: true,
      ratio: 1,
      units: [],
    },
  };
}

function context(outputDir: string, overrides: Partial<ReportBuildContext> = {}): ReportBuildContext {
  return {
    workflowRunId: RUN_ID,
    outputDir,
    packageVersion: '0.1.0',
    generatedAt: GENERATED_AT,
    ...overrides,
  };
}

async function expectError(promise: Promise<unknown>, code: ReviewError['code']): Promise<ReviewError> {
  try {
    await promise;
  } catch (error) {
    expect(isReviewError(error)).toBe(true);
    expect((error as ReviewError).code).toBe(code);
    return error as ReviewError;
  }
  throw new Error(`expected ${code}`);
}

describe('FileReportBuilder', () => {
  it('exports a complete run to JSON and Markdown with one consistent model', async () => {
    const dir = await makeTempDir();
    const builder = new FileReportBuilder();
    const result = makeResult();

    const output = await builder.exportReport(
      { workflowRunId: RUN_ID, formats: ['json', 'markdown'] },
      result,
      context(dir),
    );

    expect(output.status).toBe('exported');
    expect(output.completion).toBe('complete');
    expect(output.outcome).toBe('findings');
    expect(output.findings).toEqual({ total: 1, byPriority: { P0: 0, P1: 1, P2: 0, P3: 0 } });
    expect(output.coverage).toMatchObject({ required: 2, reviewed: 2, ratio: 1, complete: true });
    expect(output.gaps).toEqual([]);
    expect(output.reportId).toMatch(/^rpt_[0-9a-f]{16}$/u);
    expect(output.files).toHaveLength(2);

    const jsonFile = output.files.find((file) => file.format === 'json');
    const markdownFile = output.files.find((file) => file.format === 'markdown');
    const realDir = await realpath(dir);
    expect(jsonFile?.path).toBe(join(realDir, `${output.reportId}.json`));
    expect(markdownFile?.path).toBe(join(realDir, `${output.reportId}.md`));

    for (const file of output.files) {
      const info = await stat(file.path);
      expect(info.mode & 0o777).toBe(0o600);
      expect(file.digest).toBe(digestBytes(await readFile(file.path)));
    }

    const json = JSON.parse(await readFile(jsonFile?.path as string, 'utf8')) as Record<string, unknown>;
    expect(Object.keys(json)).toEqual([
      'identity',
      'source',
      'scope',
      'manifest',
      'completion',
      'outcome',
      'coverage',
      'confirmed',
      'rejected',
      'unresolved',
      'gaps',
      'attempts',
      'generatedAt',
    ]);
    expect(json.identity).toMatchObject({
      formatVersion: 1,
      reportId: output.reportId,
      workflowRunId: RUN_ID,
      reviewKey: 'rk-1',
      packageVersion: '0.1.0',
      rulesDigest: 'sha256:rules',
      skillDigests: { 'review-code': 'sha256:skill-1', 'review-verify': 'sha256:skill-2' },
    });
    expect(json.source).toMatchObject({ repoId: 'repo-1', mode: 'range', baseSha: BASE_SHA, headSha: HEAD_SHA });
    expect(json.scope).toEqual({ include: [], exclude: [], includeTests: true, includeDeleted: true });
    expect(json.completion).toBe('complete');
    expect(json.outcome).toBe('findings');
    expect(json.coverage).toMatchObject({ required: 2, reviewed: 2, reused: 0, skipped: 0, failed: 0, pending: 0 });
    expect(json.generatedAt).toBe(GENERATED_AT);

    const confirmed = json.confirmed as Array<Record<string, unknown>>;
    expect(confirmed).toHaveLength(1);
    expect(Object.keys(confirmed[0] ?? {})).toEqual([
      'candidateId',
      'unitId',
      'category',
      'priority',
      'title',
      'trigger',
      'impact',
      'location',
      'evidence',
      'verdict',
      'verification',
    ]);
    expect(confirmed[0]?.verdict).toBe('confirmed');
    expect(json.rejected).toEqual([]);
    expect(json.unresolved).toEqual([]);
    expect(json.attempts).toHaveLength(1);

    const markdown = await readFile(markdownFile?.path as string, 'utf8');
    expect(markdown).toContain('# Code review report');
    expect(markdown).toContain(`- Report: \`${output.reportId}\``);
    expect(markdown).toContain('## Source');
    expect(markdown).toContain('## Scope');
    expect(markdown).toContain('### Coverage');
    expect(markdown).toContain('## Completion');
    expect(markdown).toContain('## Confirmed findings (1)');
    expect(markdown).toContain('## Rejected findings (0)');
    expect(markdown).toContain('## Unresolved findings (0)');
    expect(markdown).toContain('## Redundancy check');
    expect(markdown).toContain('## Gaps');
    expect(markdown).toContain('## Process');
    expect(markdown).toContain('## Delivery');
    expect(markdown).toContain('### [P1] correctness: `src/a.ts:10-12`');
    expect(markdown).toContain('Null dereference');
    expect(markdown).toContain('src/b.ts');
    expect(markdown).toContain('`sha256:');
  });

  it('recomputes coverage from the manifest and reports missing checks and units', async () => {
    const dir = await makeTempDir();
    const builder = new FileReportBuilder();
    const result = makeResult();
    result.unitResults = [unitResult('u1', [], [candidate()])];

    const rejected = await expectError(
      builder.exportReport({ workflowRunId: RUN_ID, formats: ['json'] }, result, context(dir)),
      'INCOMPLETE_COVERAGE',
    );
    const details = rejected.details as { gaps: Array<{ code: string }>; coverage: { reviewed: number; pending: number } };
    expect(details.gaps.map((gap) => gap.code)).toEqual(['CHECK_MISSING', 'UNIT_PENDING']);
    expect(details.coverage).toMatchObject({ required: 2, reviewed: 0, pending: 2, complete: false, ratio: 0 });

    const output = await builder.exportReport(
      { workflowRunId: RUN_ID, formats: ['json', 'markdown'], allowPartial: true },
      result,
      context(dir),
    );
    expect(output.status).toBe('partial');
    expect(output.completion).toBe('partial');
    expect(output.outcome).toBe('inconclusive');
    expect(output.coverage).toMatchObject({ reviewed: 0, pending: 2, ratio: 0, complete: false });
    expect(output.gaps.map((gap) => gap.code)).toEqual(['CHECK_MISSING', 'UNIT_PENDING']);
    expect(output.findings.total).toBe(1);

    const json = JSON.parse(await readFile(output.files[0]?.path as string, 'utf8')) as Record<string, unknown>;
    expect(json.completion).toBe('partial');
    expect((json.gaps as unknown[]).length).toBe(2);
    const markdown = await readFile(output.files[1]?.path as string, 'utf8');
    expect(markdown).toContain('- Completion: **partial**');
    expect(markdown).toContain('`CHECK_MISSING`');
    expect(markdown).toContain('`UNIT_PENDING`');
    expect(markdown).toContain('## Confirmed findings (1)');
  });

  it('treats a missing verification as unresolved and keeps the candidate', async () => {
    const dir = await makeTempDir();
    const result = makeResult();
    result.verificationResults = [];
    const output = await new FileReportBuilder().exportReport(
      { workflowRunId: RUN_ID, formats: ['json', 'markdown'], allowPartial: true },
      result,
      context(dir),
    );

    expect(output.completion).toBe('partial');
    expect(output.outcome).toBe('inconclusive');
    expect(output.findings.total).toBe(0);
    expect(output.gaps.map((gap) => gap.code)).toContain('VERIFICATION_MISSING');

    const json = JSON.parse(await readFile(output.files[0]?.path as string, 'utf8')) as Record<string, unknown>;
    expect((json.confirmed as unknown[]).length).toBe(0);
    expect((json.unresolved as unknown[]).length).toBe(1);
    expect(json.rejected).toEqual([]);
    const markdown = await readFile(output.files[1]?.path as string, 'utf8');
    expect(markdown).toContain('## Unresolved findings (1)');
  });

  it('applies a suggested priority and preserves the original value', async () => {
    const dir = await makeTempDir();
    const result = makeResult();
    result.verificationResults[0] = {
      ...verification(),
      suggestedPriority: 'P0',
      reason: 'higher impact than first assessed',
    };

    const output = await new FileReportBuilder().exportReport(
      { workflowRunId: RUN_ID, formats: ['json', 'markdown'] },
      result,
      context(dir),
    );
    expect(output.findings).toEqual({ total: 1, byPriority: { P0: 1, P1: 0, P2: 0, P3: 0 } });

    const json = JSON.parse(await readFile(output.files[0]?.path as string, 'utf8')) as Record<string, unknown>;
    const confirmed = json.confirmed as Array<Record<string, unknown>>;
    expect(confirmed[0]).toMatchObject({
      priority: 'P0',
      originalPriority: 'P1',
      priorityChangeReason: 'higher impact than first assessed',
    });
    const markdown = await readFile(output.files[1]?.path as string, 'utf8');
    expect(markdown).toContain('- Priority: P0 (was P1): higher impact than first assessed');
  });

  it('treats zero reviewable units as noChanges with a null ratio', async () => {
    const dir = await makeTempDir();
    const result = makeResult();
    result.manifest.units = [];
    result.manifest.totalUnits = 0;
    result.manifest.excluded = [];
    result.areasByUnit = [];
    result.unitResults = [];
    result.verificationResults = [];
    result.attempts = [];

    const output = await new FileReportBuilder().exportReport(
      { workflowRunId: RUN_ID, formats: ['json', 'markdown'] },
      result,
      context(dir),
    );
    expect(output.status).toBe('exported');
    expect(output.completion).toBe('complete');
    expect(output.outcome).toBe('noChanges');
    expect(output.coverage).toMatchObject({ required: 0, reviewed: 0, complete: true, ratio: null });

    const json = JSON.parse(await readFile(output.files[0]?.path as string, 'utf8')) as Record<string, unknown>;
    expect((json.coverage as Record<string, unknown>).ratio).toBeNull();
    const markdown = await readFile(output.files[1]?.path as string, 'utf8');
    expect(markdown).toContain('| `complete` | `noChanges` |');
    expect(markdown).toContain('n/a');
    expect(markdown).not.toContain('100.000');
  });

  it('rejects empty and duplicate formats before touching the output directory', async () => {
    const dir = await makeTempDir();
    const outputDir = join(dir, 'reports');
    const builder = new FileReportBuilder();

    await expectError(
      builder.exportReport({ workflowRunId: RUN_ID, formats: [] }, makeResult(), context(outputDir)),
      'INVALID_INPUT',
    );
    await expectError(
      builder.exportReport(
        { workflowRunId: RUN_ID, formats: ['json', 'json'] },
        makeResult(),
        context(outputDir),
      ),
      'INVALID_INPUT',
    );
    await expect(lstat(outputDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects malformed results', async () => {
    const dir = await makeTempDir();
    const builder = new FileReportBuilder();
    const exportInput = { workflowRunId: RUN_ID, formats: ['json' as const] };

    const wrongVersion = { ...makeResult(), formatVersion: 2 } as unknown as ReviewRunResult;
    await expectError(builder.exportReport(exportInput, wrongVersion, context(dir)), 'UNSUPPORTED_RUN_FORMAT');

    const badLine = makeResult();
    badLine.unitResults[0]!.candidates[0]!.location.startLine = 0;
    await expectError(builder.exportReport(exportInput, badLine, context(dir)), 'INVALID_INPUT');

    const duplicate = makeResult();
    const cloned = structuredClone(duplicate.unitResults[0]!.candidates[0]!);
    cloned.unitId = 'u2';
    duplicate.unitResults[1]!.candidates.push(cloned);
    await expectError(builder.exportReport(exportInput, duplicate, context(dir)), 'INVALID_FINDING');

    const mixed = makeResult();
    mixed.unitResults[0]!.reviewKey = 'other-key';
    await expectError(builder.exportReport(exportInput, mixed, context(dir)), 'INVALID_INPUT');

    const traversal = makeResult();
    traversal.unitResults[0]!.candidates[0]!.location.path = '../secret.ts';
    await expectError(builder.exportReport(exportInput, traversal, context(dir)), 'INVALID_INPUT');
  });

  it('rejects a context or result bound to another workflow run', async () => {
    const dir = await makeTempDir();
    const builder = new FileReportBuilder();
    const exportInput = { workflowRunId: RUN_ID, formats: ['json' as const] };

    await expectError(
      builder.exportReport(exportInput, makeResult(), context(dir, { workflowRunId: 'run-2' })),
      'INVALID_INPUT',
    );

    const foreign = makeResult();
    foreign.workflowRunId = 'run-2';
    await expectError(builder.exportReport(exportInput, foreign, context(dir)), 'INVALID_INPUT');
  });

  it('reuses identical reports and refuses to overwrite conflicting content', async () => {
    const dir = await makeTempDir();
    const builder = new FileReportBuilder();
    const exportInput: ExportCodeReviewInput = { workflowRunId: RUN_ID, formats: ['json', 'markdown'] };
    const first = await builder.exportReport(exportInput, makeResult(), context(dir));
    const firstJson = first.files.find((file) => file.format === 'json');
    const firstInfo = await stat(firstJson?.path as string);

    const second = await builder.exportReport(exportInput, makeResult(), context(dir));
    expect(second.reportId).toBe(first.reportId);
    expect(second.files.map((file) => file.path)).toEqual(first.files.map((file) => file.path));
    expect(second.files.map((file) => file.digest)).toEqual(first.files.map((file) => file.digest));
    const reusedInfo = await stat(firstJson?.path as string);
    expect(reusedInfo.mtimeMs).toBe(firstInfo.mtimeMs);
    expect((await readdir(dir)).sort()).toEqual([`${first.reportId}.json`, `${first.reportId}.md`].sort());

    await writeFile(firstJson?.path as string, '{"tampered":true}\n', { mode: 0o600 });
    const conflict = await expectError(builder.exportReport(exportInput, makeResult(), context(dir)), 'OUTPUT_CONFLICT');
    expect(conflict.message).toContain('different report');
    expect(await readFile(firstJson?.path as string, 'utf8')).toBe('{"tampered":true}\n');
  });

  it('refuses to follow a symlink planted at the report path', async () => {
    const dir = await makeTempDir();
    const outside = await makeTempDir('ocr-outside-');
    const builder = new FileReportBuilder();
    const exportInput = { workflowRunId: RUN_ID, formats: ['json' as const] };
    const first = await builder.exportReport(exportInput, makeResult(), context(dir));
    const reportPath = first.files[0]?.path as string;
    await rm(reportPath);

    const target = join(outside, 'target.json');
    await writeFile(target, 'keep me\n');
    await symlink(target, reportPath);

    await expectError(builder.exportReport(exportInput, makeResult(), context(dir)), 'OUTPUT_CONFLICT');
    expect(await readFile(target, 'utf8')).toBe('keep me\n');
  });

  it('rejects an output path that is a file', async () => {
    const dir = await makeTempDir();
    const outputDir = join(dir, 'not-a-dir');
    await writeFile(outputDir, 'x');
    await expectError(
      new FileReportBuilder().exportReport(
        { workflowRunId: RUN_ID, formats: ['json'] },
        makeResult(),
        context(outputDir),
      ),
      'INVALID_INPUT',
    );
  });

  it.skipIf(runningAsRoot)('rejects an unwritable output directory', async () => {
    const dir = await makeTempDir();
    await chmod(dir, 0o500);
    try {
      await expectError(
        new FileReportBuilder().exportReport(
          { workflowRunId: RUN_ID, formats: ['json'] },
          makeResult(),
          context(dir),
        ),
        'INVALID_INPUT',
      );
    } finally {
      await chmod(dir, 0o700);
    }
  });

  it('creates a missing output directory with writable files', async () => {
    const parent = await makeTempDir();
    const outputDir = join(parent, 'nested', 'reports');
    const output = await new FileReportBuilder().exportReport(
      { workflowRunId: RUN_ID, formats: ['json'] },
      makeResult(),
      context(outputDir),
    );
    const file = output.files[0];
    expect(file?.path.startsWith(await realpath(outputDir))).toBe(true);
    expect((await stat(file?.path as string)).isFile()).toBe(true);
  });
});
