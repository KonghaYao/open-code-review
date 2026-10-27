// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, lstat, link, mkdir, open, readFile, realpath, stat, unlink } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

import { ReviewError } from '../domain/errors.js';
import type { ExportFormat, ExportedFile } from '../domain/types.js';
import { digestBytes } from '../git/hash.js';
import { isWithin } from '../git/paths.js';

export interface ReportFileRequest {
  format: ExportFormat;
  content: string;
}

const REPORT_ID_PATTERN = /^[A-Za-z0-9_-]+$/u;

export function reportFileName(reportId: string, format: ExportFormat): string {
  if (!REPORT_ID_PATTERN.test(reportId)) {
    throw new ReviewError('INVALID_INPUT', 'reportId contains unsafe characters', { details: { reportId } });
  }
  return `${reportId}.${format === 'json' ? 'json' : 'md'}`;
}

/**
 * Resolves the configured output directory, creating it when missing, and
 * rejects paths that are not a writable directory after symlink resolution.
 */
export async function resolveOutputDir(outputDir: string): Promise<string> {
  if (typeof outputDir !== 'string' || outputDir.trim() === '' || outputDir.includes('\0')) {
    throw new ReviewError('INVALID_INPUT', 'outputDir must be a non-empty path');
  }
  const absolute = resolve(outputDir);
  try {
    await mkdir(absolute, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new ReviewError('INVALID_INPUT', 'outputDir cannot be created', {
      details: { outputDir: absolute },
      cause: error,
    });
  }

  let real: string;
  try {
    real = await realpath(absolute);
    const stats = await stat(real);
    if (!stats.isDirectory()) {
      throw new ReviewError('INVALID_INPUT', 'outputDir is not a directory', { details: { outputDir: absolute } });
    }
    await access(real, constants.W_OK | constants.X_OK);
  } catch (error) {
    if (error instanceof ReviewError) {
      throw error;
    }
    throw new ReviewError('INVALID_INPUT', 'outputDir is not writable', {
      details: { outputDir: absolute },
      cause: error,
    });
  }
  return real;
}

/**
 * Writes every requested format before returning. Files are created with mode
 * 0600 through a temporary file and an atomic link, so a reader never observes
 * a partial report and an existing report is never overwritten.
 */
export async function writeReportFiles(
  outputDir: string,
  reportId: string,
  requests: readonly ReportFileRequest[],
): Promise<ExportedFile[]> {
  const files: ExportedFile[] = [];
  const created: string[] = [];
  try {
    for (const request of requests) {
      const finalPath = join(outputDir, reportFileName(reportId, request.format));
      if (!isWithin(outputDir, finalPath)) {
        throw new ReviewError('INVALID_INPUT', 'report path escapes outputDir', {
          details: { reportId, format: request.format },
        });
      }
      const bytes = Buffer.from(request.content, 'utf8');
      const existing = await lstatOrUndefined(finalPath);
      if (existing !== undefined) {
        const digest = await reuseExisting(outputDir, finalPath, bytes);
        files.push({ format: request.format, path: finalPath, digest });
        continue;
      }
      const result = await createReportFile(outputDir, finalPath, bytes);
      if (result.created) {
        created.push(finalPath);
      }
      files.push({ format: request.format, path: finalPath, digest: result.digest });
    }
    return files;
  } catch (error) {
    await Promise.all(created.map((path) => unlink(path).catch(() => undefined)));
    if (error instanceof ReviewError) {
      throw error;
    }
    throw new ReviewError('INTERNAL_ERROR', 'failed to write report files', {
      details: { reportId },
      cause: error,
    });
  }
}

async function reuseExisting(outputDir: string, finalPath: string, expected: Buffer): Promise<string> {
  const stats = await lstat(finalPath);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw conflict(finalPath, 'report path is not a regular file');
  }
  const real = await realpath(finalPath);
  if (!isWithin(outputDir, real)) {
    throw conflict(finalPath, 'report path escapes outputDir');
  }
  const existing = await readFile(real);
  if (!existing.equals(expected)) {
    throw conflict(finalPath, 'a different report already uses this id');
  }
  return digestBytes(existing);
}

async function createReportFile(
  outputDir: string,
  finalPath: string,
  content: Buffer,
): Promise<{ digest: string; created: boolean }> {
  const tempPath = join(outputDir, `.${basename(finalPath)}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(tempPath, 'wx', 0o600);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(tempPath, 0o600);

    try {
      await link(tempPath, finalPath);
    } catch (error) {
      if (!isErrno(error, 'EEXIST')) {
        throw error;
      }
      const digest = await reuseExisting(outputDir, finalPath, content);
      return { digest, created: false };
    }
    return { digest: digestBytes(content), created: true };
  } finally {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
    await unlink(tempPath).catch(() => undefined);
  }
}

function conflict(path: string, message: string): ReviewError {
  return new ReviewError('OUTPUT_CONFLICT', message, { details: { path } });
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === code;
}

async function lstatOrUndefined(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      return undefined;
    }
    throw error;
  }
}
