// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
import { lstat, readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { ReviewError } from '../domain/errors.js';
import type { RunStateStore } from '../domain/interfaces.js';
import type { ReviewRunResult } from '../domain/types.js';
import { isWithin } from '../git/paths.js';
import { readJournalNotes } from './journal.js';
import { restoreLongTexts } from './outputs.js';

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const MAX_RUN_ID_LENGTH = 200;

const EXECUTION_STATUSES = new Set(['running', 'completed', 'failed', 'killed', 'unknown']);
const ACCEPTANCE_STATUSES = new Set(['passed', 'failed', 'unknown']);
const POST_PROCESSING_STATUSES = new Set(['not_required', 'passed', 'failed', 'blocked', 'unknown']);
const DELIVERY_STATUSES = new Set(['blocked', 'unknown', 'deliverable']);
const DISPOSITIONS = new Set(['produced', 'recovered', 'rejected']);

const DEFAULT_MAX_STATE_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_JOURNAL_BYTES = 8 * 1024 * 1024;

export interface RunStateStoreOptions {
  maxStateBytes?: number;
  maxOutputBytes?: number;
  maxJournalBytes?: number;
}

interface Snapshot {
  file: 'state.json' | 'run.json';
  data: Record<string, unknown>;
}

interface ResolvedOptions {
  maxStateBytes: number;
  maxOutputBytes: number;
  maxJournalBytes: number;
}

/**
 * Read-only adapter over `.claude/workflow-runs`. It never writes engine state
 * or the journal, and it never reconstructs a successful result from journal
 * fragments: a run is exportable only when its state snapshot carries a
 * complete, acceptable return value.
 */
export class WorkflowRunStateStore implements RunStateStore {
  readonly workflowRoot: string;
  private readonly options: ResolvedOptions;

  constructor(workflowRoot: string, options: RunStateStoreOptions = {}) {
    if (typeof workflowRoot !== 'string' || workflowRoot.trim() === '' || workflowRoot.includes('\0')) {
      throw new ReviewError('INVALID_INPUT', 'workflowRoot must be a non-empty path');
    }
    this.workflowRoot = resolve(workflowRoot);
    this.options = {
      maxStateBytes: positiveOr(options.maxStateBytes, DEFAULT_MAX_STATE_BYTES),
      maxOutputBytes: positiveOr(options.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES),
      maxJournalBytes: positiveOr(options.maxJournalBytes, DEFAULT_MAX_JOURNAL_BYTES),
    };
  }

  async load(workflowRunId: string): Promise<ReviewRunResult> {
    assertRunId(workflowRunId);
    const root = await this.resolveRoot();
    const runDir = await this.resolveRunDir(root, workflowRunId);
    const snapshot = await this.readSnapshot(runDir, workflowRunId);

    if (snapshot === undefined) {
      const journal = await readJournalNotes(runDir, this.options.maxJournalBytes);
      throw new ReviewError('RUN_NOT_EXPORTABLE', 'run has no complete state snapshot', {
        details: {
          workflowRunId,
          reason: 'neither state.json nor run.json exists; the journal alone cannot be exported',
          ...(journal === undefined ? {} : { journal }),
        },
      });
    }

    const value = isDirectResult(snapshot.data)
      ? validateDirectEnvelope(snapshot.data, workflowRunId, snapshot.file)
      : validateStateSnapshot(snapshot.data, workflowRunId, snapshot.file);
    const restored = await restoreLongTexts(value, runDir, {
      maxOutputBytes: this.options.maxOutputBytes,
    });
    return validateResultShape(restored, workflowRunId);
  }

  private async resolveRoot(): Promise<string> {
    try {
      const real = await realpath(this.workflowRoot);
      const stats = await lstat(real);
      if (!stats.isDirectory()) {
        throw new ReviewError('RUN_NOT_FOUND', 'workflowRoot is not a directory', {
          details: { workflowRoot: this.workflowRoot },
        });
      }
      return real;
    } catch (error) {
      if (error instanceof ReviewError) {
        throw error;
      }
      throw new ReviewError('RUN_NOT_FOUND', 'workflowRoot does not exist', {
        details: { workflowRoot: this.workflowRoot },
        cause: error,
      });
    }
  }

  private async resolveRunDir(root: string, workflowRunId: string): Promise<string> {
    const candidate = join(root, workflowRunId);
    const stats = await lstatOrUndefined(candidate);
    if (stats === undefined) {
      throw new ReviewError('RUN_NOT_FOUND', 'workflow run does not exist', { details: { workflowRunId } });
    }
    if (stats.isSymbolicLink()) {
      throw new ReviewError('INVALID_INPUT', 'workflow run directory must not be a symbolic link', {
        details: { workflowRunId },
      });
    }
    if (!stats.isDirectory()) {
      throw new ReviewError('RUN_NOT_FOUND', 'workflow run is not a directory', { details: { workflowRunId } });
    }
    const real = await realpath(candidate);
    if (!isWithin(root, real)) {
      throw new ReviewError('INVALID_INPUT', 'workflow run escapes workflowRoot', { details: { workflowRunId } });
    }
    return real;
  }

  private async readSnapshot(runDir: string, workflowRunId: string): Promise<Snapshot | undefined> {
    for (const file of ['state.json', 'run.json'] as const) {
      const candidate = join(runDir, file);
      const stats = await lstatOrUndefined(candidate);
      if (stats === undefined) {
        continue;
      }
      if (stats.isSymbolicLink()) {
        throw new ReviewError('INVALID_INPUT', 'run snapshot must not be a symbolic link', {
          details: { workflowRunId, file },
        });
      }
      if (!stats.isFile()) {
        throw new ReviewError('RUN_NOT_EXPORTABLE', 'run snapshot is not a regular file', {
          details: { workflowRunId, file },
        });
      }
      if (stats.size > this.options.maxStateBytes) {
        throw new ReviewError('PAYLOAD_TOO_LARGE', 'run snapshot is larger than the readable limit', {
          details: { workflowRunId, file, bytes: stats.size, limit: this.options.maxStateBytes },
        });
      }
      const real = await realpath(candidate);
      if (!isWithin(runDir, real)) {
        throw new ReviewError('INVALID_INPUT', 'run snapshot escapes the run directory', {
          details: { workflowRunId, file },
        });
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(real, 'utf8'));
      } catch (error) {
        if (error instanceof SyntaxError) {
          throw new ReviewError('RUN_NOT_EXPORTABLE', 'run snapshot is not valid JSON', {
            details: { workflowRunId, file },
            cause: error,
          });
        }
        throw error;
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new ReviewError('UNSUPPORTED_RUN_FORMAT', 'run snapshot must be a JSON object', {
          details: { workflowRunId, file },
        });
      }
      return { file, data: parsed as Record<string, unknown> };
    }
    return undefined;
  }
}

function isDirectResult(data: Record<string, unknown>): boolean {
  return data.manifest !== undefined && data.reviewKey !== undefined && data.formatVersion !== undefined;
}

function validateDirectEnvelope(
  data: Record<string, unknown>,
  workflowRunId: string,
  file: 'state.json' | 'run.json',
): unknown {
  if (data.run_id !== undefined && data.run_id !== workflowRunId) {
    throw new ReviewError('RUN_NOT_EXPORTABLE', 'run snapshot belongs to another workflow run', {
      details: { workflowRunId, file },
    });
  }
  if (data.status !== undefined && data.status !== 'completed') {
    throw new ReviewError('RUN_NOT_EXPORTABLE', 'workflow run did not complete', {
      details: { workflowRunId, file, status: data.status },
    });
  }
  if (typeof data.error === 'string' && data.error.trim() !== '') {
    throw new ReviewError('RUN_NOT_EXPORTABLE', 'workflow run recorded an error', {
      details: { workflowRunId, file, error: data.error },
    });
  }
  return data;
}

function validateStateSnapshot(
  data: Record<string, unknown>,
  workflowRunId: string,
  file: 'state.json' | 'run.json',
): unknown {
  const runId = data.run_id;
  if (runId !== undefined) {
    if (typeof runId !== 'string' || runId === '') {
      throw unsupported(workflowRunId, file, 'run_id must be a string');
    }
    if (runId !== workflowRunId) {
      throw new ReviewError('RUN_NOT_EXPORTABLE', 'run snapshot belongs to another workflow run', {
        details: { workflowRunId, file, runId },
      });
    }
  } else if (file === 'state.json') {
    throw unsupported(workflowRunId, file, 'state.json has no run_id');
  }

  const status = data.status;
  if (status !== undefined) {
    if (typeof status !== 'string') {
      throw unsupported(workflowRunId, file, 'status must be a string');
    }
    if (status !== 'completed') {
      throw new ReviewError('RUN_NOT_EXPORTABLE', 'workflow run did not complete', {
        details: { workflowRunId, file, status },
      });
    }
  } else if (file === 'state.json') {
    throw unsupported(workflowRunId, file, 'state.json has no status');
  }

  const error = data.error;
  if (error !== undefined) {
    if (typeof error !== 'string') {
      throw unsupported(workflowRunId, file, 'error must be a string');
    }
    if (error.trim() !== '') {
      throw new ReviewError('RUN_NOT_EXPORTABLE', 'workflow run recorded an error', {
        details: { workflowRunId, file, error },
      });
    }
  }

  assertWorkflowStatus(data, 'execution_status', EXECUTION_STATUSES, new Set(['running', 'failed', 'killed']), workflowRunId, file);
  assertWorkflowStatus(data, 'acceptance_status', ACCEPTANCE_STATUSES, new Set(['failed']), workflowRunId, file);
  assertWorkflowStatus(
    data,
    'post_processing_status',
    POST_PROCESSING_STATUSES,
    new Set(['failed', 'blocked']),
    workflowRunId,
    file,
  );
  assertWorkflowStatus(data, 'delivery_status', DELIVERY_STATUSES, new Set(['blocked']), workflowRunId, file);
  validateEngineAttempts(data.attempts, workflowRunId, file);

  const returnValue = data.return_value;
  if (returnValue === undefined || returnValue === null) {
    throw new ReviewError('RUN_NOT_EXPORTABLE', 'workflow run has no complete return value', {
      details: { workflowRunId, file },
    });
  }
  return returnValue;
}

function assertWorkflowStatus(
  data: Record<string, unknown>,
  field: string,
  allowed: ReadonlySet<string>,
  blocking: ReadonlySet<string>,
  workflowRunId: string,
  file: string,
): void {
  const value = data[field];
  if (value === undefined) {
    return;
  }
  if (typeof value !== 'string' || !allowed.has(value)) {
    throw unsupported(workflowRunId, file, `${field} has an unknown value`);
  }
  if (blocking.has(value)) {
    throw new ReviewError('RUN_NOT_EXPORTABLE', `workflow ${field} is ${value}`, {
      details: { workflowRunId, file, field, value },
    });
  }
}

function validateEngineAttempts(value: unknown, workflowRunId: string, file: string): void {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    throw unsupported(workflowRunId, file, 'attempts must be an array');
  }
  for (const [index, item] of value.entries()) {
    const field = `attempts[${index}]`;
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw unsupported(workflowRunId, file, `${field} must be an object`);
    }
    const attempt = item as Record<string, unknown>;
    if (attempt.runId !== workflowRunId) {
      throw unsupported(workflowRunId, file, `${field}.runId does not match the run`);
    }
    requireNonNegativeInteger(attempt.journalSeq, workflowRunId, file, `${field}.journalSeq`);
    if (typeof attempt.consumed !== 'boolean') {
      throw unsupported(workflowRunId, file, `${field}.consumed must be a boolean`);
    }
    if (typeof attempt.disposition !== 'string' || !DISPOSITIONS.has(attempt.disposition)) {
      throw unsupported(workflowRunId, file, `${field}.disposition has an unknown value`);
    }
    if (attempt.agentId !== undefined) {
      requireNonNegativeInteger(attempt.agentId, workflowRunId, file, `${field}.agentId`);
    }
    if (attempt.recoveredFrom !== undefined) {
      const from = attempt.recoveredFrom;
      if (from === null || typeof from !== 'object' || Array.isArray(from)) {
        throw unsupported(workflowRunId, file, `${field}.recoveredFrom must be an object`);
      }
      const recovered = from as Record<string, unknown>;
      if (typeof recovered.runId !== 'string' || recovered.runId === '') {
        throw unsupported(workflowRunId, file, `${field}.recoveredFrom.runId must be a string`);
      }
      requireNonNegativeInteger(recovered.journalSeq, workflowRunId, file, `${field}.recoveredFrom.journalSeq`);
    }
  }
}

function requireNonNegativeInteger(value: unknown, workflowRunId: string, file: string, field: string): void {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw unsupported(workflowRunId, file, `${field} must be a non-negative integer`);
  }
}

/**
 * Checks the shape needed to hand the value to the report validator. Field
 * enums, identities and line ranges are validated there; this only rejects a
 * missing or obviously incomplete aggregate.
 */
function validateResultShape(value: unknown, workflowRunId: string): ReviewRunResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw notExportable(workflowRunId, 'return value', 'return value must be a JSON object');
  }
  const result = value as Record<string, unknown>;
  if (result.formatVersion !== 1) {
    throw new ReviewError('UNSUPPORTED_RUN_FORMAT', 'review result formatVersion is not supported', {
      details: { workflowRunId, formatVersion: result.formatVersion },
    });
  }
  if (typeof result.reviewKey !== 'string' || result.reviewKey === '') {
    throw notExportable(workflowRunId, 'reviewKey', 'reviewKey must be a non-empty string');
  }
  if (result.workflowRunId !== undefined) {
    if (typeof result.workflowRunId !== 'string' || result.workflowRunId === '') {
      throw notExportable(workflowRunId, 'workflowRunId', 'workflowRunId must be a string');
    }
    if (result.workflowRunId !== workflowRunId) {
      throw notExportable(workflowRunId, 'workflowRunId', 'review result belongs to another workflow run');
    }
  }

  const input = result.input;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw notExportable(workflowRunId, 'input', 'input must be an object');
  }
  if (typeof (input as Record<string, unknown>).mode !== 'string') {
    throw notExportable(workflowRunId, 'input.mode', 'input.mode must be a string');
  }

  const manifest = result.manifest;
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw notExportable(workflowRunId, 'manifest', 'manifest must be an object');
  }
  const manifestRecord = manifest as Record<string, unknown>;
  if (typeof manifestRecord.reviewKey !== 'string' || manifestRecord.reviewKey !== result.reviewKey) {
    throw notExportable(workflowRunId, 'manifest.reviewKey', 'manifest.reviewKey must match the run reviewKey');
  }
  if (!Array.isArray(manifestRecord.units)) {
    throw notExportable(workflowRunId, 'manifest.units', 'manifest.units must be an array');
  }

  for (const field of ['areasByUnit', 'unitResults', 'verificationResults', 'attempts', 'gaps'] as const) {
    if (!Array.isArray(result[field])) {
      throw notExportable(workflowRunId, field, `${field} must be an array`);
    }
  }
  const coverage = result.coverage;
  if (coverage === null || typeof coverage !== 'object' || Array.isArray(coverage)) {
    throw notExportable(workflowRunId, 'coverage', 'coverage must be an object');
  }

  result.workflowRunId = workflowRunId;
  return result as unknown as ReviewRunResult;
}

function notExportable(workflowRunId: string, field: string, message: string): ReviewError {
  return new ReviewError('RUN_NOT_EXPORTABLE', message, { details: { workflowRunId, field } });
}

function unsupported(workflowRunId: string, file: string, message: string): ReviewError {
  return new ReviewError('UNSUPPORTED_RUN_FORMAT', message, { details: { workflowRunId, file } });
}

function assertRunId(workflowRunId: string): void {
  if (
    typeof workflowRunId !== 'string' ||
    workflowRunId.length === 0 ||
    workflowRunId.length > MAX_RUN_ID_LENGTH ||
    !RUN_ID_PATTERN.test(workflowRunId) ||
    workflowRunId.includes('..')
  ) {
    throw new ReviewError('INVALID_INPUT', 'workflowRunId must be a single safe path segment', {
      details: { workflowRunId },
    });
  }
}

function positiveOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

async function lstatOrUndefined(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}
