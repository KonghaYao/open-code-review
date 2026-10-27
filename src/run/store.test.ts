// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ReviewError, isReviewError } from '../domain/errors.js';
import type { ReviewRunResult } from '../domain/types.js';
import { WorkflowRunStateStore } from './index.js';

const BASE_SHA = '1111111111111111111111111111111111111111';
const HEAD_SHA = '2222222222222222222222222222222222222222';
const RUN_ID = 'run-1';
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(prefix = 'ocr-run-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeResult(): ReviewRunResult {
  const input = { mode: 'range' as const, from: 'main', to: 'feature' };
  return {
    formatVersion: 1,
    reviewKey: 'rk-1',
    input,
    manifest: {
      reviewKey: 'rk-1',
      input,
      source: {
        repoId: 'repo-1',
        mode: 'range',
        requestedRefs: { from: 'main', to: 'feature' },
        baseSha: BASE_SHA,
        headSha: HEAD_SHA,
        mergeBaseSha: BASE_SHA,
        comparison: 'merge-base',
      },
      scope: { include: [], exclude: [], includeTests: true, includeDeleted: true },
      units: [
        {
          unitId: 'u1',
          kind: 'file',
          changeIds: ['change-1'],
          paths: ['src/a.ts'],
          relatedPaths: [],
          side: 'head',
          startLine: 1,
          endLine: 10,
          slices: [{ hunkIndex: 0, start: 1, end: 10 }],
          fullFile: false,
          ruleRefs: [{ source: 'system', pattern: '**/*.ts' }],
          status: 'pending',
        },
      ],
      excluded: [],
      manifestDigest: 'sha256:manifest',
      totalUnits: 1,
      rulesDigest: 'sha256:rules',
      skillDigests: { 'review-code': 'sha256:skill' },
      serverVersion: '0.1.0',
    },
    areasByUnit: [
      {
        unitId: 'u1',
        areas: ['logic'],
        checks: [{ checkId: 'c1', ruleId: 'r1', text: 'check' }],
        ruleIds: ['r1'],
        rulesDigest: 'sha256:rules',
      },
    ],
    unitResults: [
      {
        unitId: 'u1',
        reviewKey: 'rk-1',
        status: 'reviewed',
        checkedCheckIds: ['c1'],
        notApplicable: [],
        candidates: [],
      },
    ],
    verificationResults: [],
    attempts: [],
    gaps: [],
    coverage: {
      required: 1,
      reviewed: 1,
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

function makeState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    run_id: RUN_ID,
    workflow_name: 'code-review',
    status: 'completed',
    execution_status: 'completed',
    acceptance_status: 'unknown',
    post_processing_status: 'not_required',
    delivery_status: 'unknown',
    attempts: [],
    return_value: makeResult(),
    script: 'export const meta = {}',
    started_at: '2026-10-27T00:00:00.000Z',
    finished_at: '2026-10-27T00:01:00.000Z',
    ...overrides,
  };
}

async function prepareRun(
  root: string,
  runId = RUN_ID,
  state: Record<string, unknown> | null = makeState(),
): Promise<string> {
  const runDir = join(root, runId);
  await mkdir(runDir, { recursive: true });
  if (state !== null) {
    await writeFile(join(runDir, 'state.json'), JSON.stringify(state, null, 2));
  }
  return runDir;
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

describe('WorkflowRunStateStore', () => {
  it('loads a completed state without writing engine files', async () => {
    const root = await makeTempDir();
    const runDir = await prepareRun(root);
    await writeFile(
      join(runDir, 'journal.jsonl'),
      JSON.stringify({ seq: 1, result: { kind: 'ok', phase: 'review', output: { unitId: 'u1' } } }) + '\n',
    );
    const statePath = join(runDir, 'state.json');
    const journalPath = join(runDir, 'journal.jsonl');
    const stateBytes = await readFile(statePath);
    const journalBytes = await readFile(journalPath);
    const stateMtime = (await stat(statePath)).mtimeMs;
    const journalMtime = (await stat(journalPath)).mtimeMs;
    const listing = (await readdir(runDir)).sort();

    const store = new WorkflowRunStateStore(root);
    expect(store.workflowRoot).toBe(resolve(root));
    const result = await store.load(RUN_ID);

    expect(result.workflowRunId).toBe(RUN_ID);
    expect(result.reviewKey).toBe('rk-1');
    expect(result.manifest.units).toHaveLength(1);
    expect(result.coverage.reviewed).toBe(1);

    expect((await readFile(statePath)).equals(stateBytes)).toBe(true);
    expect((await readFile(journalPath)).equals(journalBytes)).toBe(true);
    expect((await stat(statePath)).mtimeMs).toBe(stateMtime);
    expect((await stat(journalPath)).mtimeMs).toBe(journalMtime);
    expect((await readdir(runDir)).sort()).toEqual(listing);
  });

  it('restores long text references from outputs and leaves other strings alone', async () => {
    const root = await makeTempDir();
    const result = makeResult();
    result.input.from = '${from-ref}';
    result.manifest.units[0]!.paths = ['${path-label}'];
    result.manifest.units[0]!.ruleRefs[0]!.pattern = 'prefix ${not-a-reference}';
    result.gaps = [{ code: 'NOTE', message: '${note-label}' }];
    const runDir = await prepareRun(root, RUN_ID, makeState({ return_value: result }));
    await mkdir(join(runDir, 'outputs'));
    await writeFile(join(runDir, 'outputs', 'from-ref.txt'), 'release-1');
    await writeFile(join(runDir, 'outputs', 'path-label.txt'), 'src/restored.ts');
    await writeFile(join(runDir, 'outputs', 'note-label.txt'), 'restored note\nsecond line');

    const loaded = await new WorkflowRunStateStore(root).load(RUN_ID);
    expect(loaded.input.from).toBe('release-1');
    expect(loaded.manifest.units[0]?.paths).toEqual(['src/restored.ts']);
    expect(loaded.manifest.units[0]?.ruleRefs[0]?.pattern).toBe('prefix ${not-a-reference}');
    expect(loaded.gaps[0]?.message).toBe('restored note\nsecond line');
  });

  it('rejects a missing extracted-text file and unsafe labels', async () => {
    const root = await makeTempDir();
    const missing = makeResult();
    missing.gaps = [{ code: 'NOTE', message: '${missing-label}' }];
    const runDir = await prepareRun(root, RUN_ID, makeState({ return_value: missing }));
    await mkdir(join(runDir, 'outputs'));
    const error = await expectError(new WorkflowRunStateStore(root).load(RUN_ID), 'RUN_NOT_EXPORTABLE');
    expect(error.details).toMatchObject({ label: 'missing-label' });

    const unsafe = makeResult();
    unsafe.gaps = [{ code: 'NOTE', message: '${../secret}' }];
    const otherRoot = await makeTempDir();
    await prepareRun(otherRoot, RUN_ID, makeState({ return_value: unsafe }));
    await expectError(new WorkflowRunStateStore(otherRoot).load(RUN_ID), 'INVALID_INPUT');
  });

  it('rejects a symlinked outputs directory', async () => {
    const root = await makeTempDir();
    const outside = await makeTempDir('ocr-run-outside-');
    const result = makeResult();
    result.gaps = [{ code: 'NOTE', message: '${note}' }];
    const runDir = await prepareRun(root, RUN_ID, makeState({ return_value: result }));
    await writeFile(join(outside, 'note.txt'), 'leak');
    await symlink(outside, join(runDir, 'outputs'));

    await expectError(new WorkflowRunStateStore(root).load(RUN_ID), 'INVALID_INPUT');
  });

  it('accepts run.json as a direct result or a state snapshot', async () => {
    const directRoot = await makeTempDir();
    const directDir = join(directRoot, RUN_ID);
    await mkdir(directDir, { recursive: true });
    await writeFile(join(directDir, 'run.json'), JSON.stringify(makeResult()));

    const direct = await new WorkflowRunStateStore(directRoot).load(RUN_ID);
    expect(direct.workflowRunId).toBe(RUN_ID);
    expect(direct.reviewKey).toBe('rk-1');

    const snapshotRoot = await makeTempDir();
    const snapshotDir = join(snapshotRoot, RUN_ID);
    await mkdir(snapshotDir, { recursive: true });
    await writeFile(join(snapshotDir, 'run.json'), JSON.stringify({ return_value: makeResult() }));

    const snapshot = await new WorkflowRunStateStore(snapshotRoot).load(RUN_ID);
    expect(snapshot.workflowRunId).toBe(RUN_ID);
  });

  it('uses the journal only for status and notes, never for a successful result', async () => {
    const root = await makeTempDir();
    const runDir = await prepareRun(root, RUN_ID, null);
    await writeFile(
      join(runDir, 'journal.jsonl'),
      [
        JSON.stringify({ seq: 1, result: { kind: 'ok', phase: 'review', output: { candidates: [] } } }),
        JSON.stringify({ seq: 2, result: { kind: 'dead', phase: 'review', reason: 'killed', detail: 'timeout' } }),
        'not json',
      ].join('\n') + '\n',
    );

    const error = await expectError(new WorkflowRunStateStore(root).load(RUN_ID), 'RUN_NOT_EXPORTABLE');
    expect(error.details).toMatchObject({
      workflowRunId: RUN_ID,
      journal: {
        entries: 2,
        ok: 1,
        dead: 1,
        skipped: 0,
        invalidLines: 1,
        phases: ['review'],
        last: { kind: 'dead', phase: 'review', reason: 'killed', detail: 'timeout' },
      },
    });

    const onlyOkRoot = await makeTempDir();
    const onlyOkDir = await prepareRun(onlyOkRoot, RUN_ID, null);
    await writeFile(
      join(onlyOkDir, 'journal.jsonl'),
      JSON.stringify({ seq: 1, result: { kind: 'ok', phase: 'review', output: { accepted: true } } }) + '\n',
    );
    await expectError(new WorkflowRunStateStore(onlyOkRoot).load(RUN_ID), 'RUN_NOT_EXPORTABLE');
  });

  it('rejects failed, killed or unaccepted workflows and incomplete return values', async () => {
    const root = await makeTempDir();
    const cases: Array<[string, Record<string, unknown>, ReviewError['code']]> = [
      ['failed status', { status: 'failed' }, 'RUN_NOT_EXPORTABLE'],
      ['running status', { status: 'running' }, 'RUN_NOT_EXPORTABLE'],
      ['failed execution', { execution_status: 'failed' }, 'RUN_NOT_EXPORTABLE'],
      ['killed execution', { execution_status: 'killed' }, 'RUN_NOT_EXPORTABLE'],
      ['failed acceptance', { acceptance_status: 'failed' }, 'RUN_NOT_EXPORTABLE'],
      ['blocked post processing', { post_processing_status: 'blocked' }, 'RUN_NOT_EXPORTABLE'],
      ['blocked delivery', { delivery_status: 'blocked' }, 'RUN_NOT_EXPORTABLE'],
      ['recorded error', { error: 'boom' }, 'RUN_NOT_EXPORTABLE'],
      ['missing return value', { return_value: null }, 'RUN_NOT_EXPORTABLE'],
      ['foreign run id', { run_id: 'other-run' }, 'RUN_NOT_EXPORTABLE'],
    ];
    for (const [name, overrides, code] of cases) {
      const runId = `run-${name.replaceAll(' ', '-')}`;
      const state = makeState({ ...overrides, run_id: overrides.run_id ?? runId });
      await prepareRun(root, runId, state);
      const error = await expectError(new WorkflowRunStateStore(root).load(runId), code);
      expect(error.details, name).toBeDefined();
    }
  });

  it('rejects unknown formats and malformed aggregate data', async () => {
    const root = await makeTempDir();
    const cases: Array<[string, Record<string, unknown>, ReviewError['code']]> = [
      ['unknown execution status', { execution_status: 'paused' }, 'UNSUPPORTED_RUN_FORMAT'],
      ['unknown run result version', { return_value: { ...makeResult(), formatVersion: 2 } }, 'UNSUPPORTED_RUN_FORMAT'],
      ['missing manifest', { return_value: { ...makeResult(), manifest: null } }, 'RUN_NOT_EXPORTABLE'],
      ['missing unit results', { return_value: { ...makeResult(), unitResults: undefined } }, 'RUN_NOT_EXPORTABLE'],
      ['missing review key', { return_value: { ...makeResult(), reviewKey: '' } }, 'RUN_NOT_EXPORTABLE'],
      [
        'bad engine attempts',
        { attempts: [{ runId: RUN_ID, journalSeq: 1, consumed: true, disposition: 'replayed' }] },
        'UNSUPPORTED_RUN_FORMAT',
      ],
      ['missing status', { status: undefined }, 'UNSUPPORTED_RUN_FORMAT'],
    ];
    for (const [name, overrides, code] of cases) {
      const runId = `run-${name.replaceAll(' ', '-')}`;
      const state = { ...makeState(), ...overrides, run_id: runId };
      await prepareRun(root, runId, state);
      await expectError(new WorkflowRunStateStore(root).load(runId), code);
    }
  });

  it('rejects path traversal and unsafe run ids', async () => {
    const root = await makeTempDir();
    const store = new WorkflowRunStateStore(root);
    for (const runId of ['../run', 'run/1', 'run\\1', '..', '', 'a..b', './run', '.', 'x'.repeat(201)]) {
      await expectError(store.load(runId), 'INVALID_INPUT');
    }
  });

  it('rejects missing roots and missing runs', async () => {
    const root = await makeTempDir();
    await expectError(new WorkflowRunStateStore(join(root, 'absent')).load(RUN_ID), 'RUN_NOT_FOUND');
    await expectError(new WorkflowRunStateStore(root).load(RUN_ID), 'RUN_NOT_FOUND');
  });

  it('rejects symlinked run directories and state files', async () => {
    const root = await makeTempDir();
    const outside = await makeTempDir('ocr-run-outside-');
    const outsideDir = await prepareRun(outside);
    await symlink(outsideDir, join(root, RUN_ID));
    await expectError(new WorkflowRunStateStore(root).load(RUN_ID), 'INVALID_INPUT');

    const fileRoot = await makeTempDir();
    const fileRun = await prepareRun(fileRoot);
    const outsideFile = join(outside, 'state.json');
    await writeFile(outsideFile, JSON.stringify(makeState()));
    await rm(join(fileRun, 'state.json'));
    await symlink(outsideFile, join(fileRun, 'state.json'));
    await expectError(new WorkflowRunStateStore(fileRoot).load(RUN_ID), 'INVALID_INPUT');
  });

  it('rejects corrupt and non-regular snapshots', async () => {
    const corruptRoot = await makeTempDir();
    const corruptRun = join(corruptRoot, RUN_ID);
    await mkdir(corruptRun, { recursive: true });
    await writeFile(join(corruptRun, 'state.json'), '{"run_id": ');
    await expectError(new WorkflowRunStateStore(corruptRoot).load(RUN_ID), 'RUN_NOT_EXPORTABLE');

    const directoryRoot = await makeTempDir();
    const directoryRun = join(directoryRoot, RUN_ID);
    await mkdir(join(directoryRun, 'state.json'), { recursive: true });
    await expectError(new WorkflowRunStateStore(directoryRoot).load(RUN_ID), 'RUN_NOT_EXPORTABLE');
  });

  it('enforces configured size limits', async () => {
    const root = await makeTempDir();
    await prepareRun(root);
    await expectError(new WorkflowRunStateStore(root, { maxStateBytes: 10 }).load(RUN_ID), 'PAYLOAD_TOO_LARGE');

    const outputRoot = await makeTempDir();
    const result = makeResult();
    result.gaps = [{ code: 'NOTE', message: '${big}' }];
    const runDir = await prepareRun(outputRoot, RUN_ID, makeState({ return_value: result }));
    await mkdir(join(runDir, 'outputs'));
    await writeFile(join(runDir, 'outputs', 'big.txt'), '0123456789');
    await expectError(
      new WorkflowRunStateStore(outputRoot, { maxOutputBytes: 4 }).load(RUN_ID),
      'PAYLOAD_TOO_LARGE',
    );
  });
});
