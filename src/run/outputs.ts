// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
import { lstat, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';

import { ReviewError } from '../domain/errors.js';
import { isWithin } from '../git/paths.js';

const PLACEHOLDER = /^\$\{([^}]+)\}$/u;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

export interface OutputRestoreOptions {
  maxOutputBytes: number;
}

/**
 * Restores `${label}` references produced by Ultracode's long-text extraction.
 * Only a complete string placeholder is a reference; the label is checked and
 * the referenced file must resolve inside `outputs/`.
 */
export async function restoreLongTexts(
  value: unknown,
  runDir: string,
  options: OutputRestoreOptions,
): Promise<unknown> {
  if (!hasPlaceholder(value)) {
    return value;
  }
  const cache = new Map<string, string>();
  const resolve = async (label: string): Promise<string> => {
    const cached = cache.get(label);
    if (cached !== undefined) {
      return cached;
    }
    const text = await readOutput(runDir, label, options);
    cache.set(label, text);
    return text;
  };
  return replaceValue(value, resolve);
}

function hasPlaceholder(value: unknown): boolean {
  if (typeof value === 'string') {
    return PLACEHOLDER.test(value);
  }
  if (Array.isArray(value)) {
    return value.some(hasPlaceholder);
  }
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(hasPlaceholder);
  }
  return false;
}

async function replaceValue(value: unknown, resolve: (label: string) => Promise<string>): Promise<unknown> {
  if (typeof value === 'string') {
    const match = PLACEHOLDER.exec(value);
    return match === null ? value : resolve(match[1] as string);
  }
  if (Array.isArray(value)) {
    const items: unknown[] = [];
    for (const item of value) {
      items.push(await replaceValue(item, resolve));
    }
    return items;
  }
  if (value !== null && typeof value === 'object') {
    const restored: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      restored[key] = await replaceValue(item, resolve);
    }
    return restored;
  }
  return value;
}

async function readOutput(runDir: string, label: string, options: OutputRestoreOptions): Promise<string> {
  assertSafeLabel(label);
  const outputsDir = await resolveOutputsDir(runDir);
  const filePath = join(outputsDir, `${label}.txt`);
  if (!isWithin(outputsDir, filePath)) {
    throw new ReviewError('INVALID_INPUT', 'long-text reference escapes the outputs directory', {
      details: { label },
    });
  }
  const stats = await lstatOrUndefined(filePath);
  if (stats === undefined) {
    throw new ReviewError('RUN_NOT_EXPORTABLE', 'referenced long text is missing from the run outputs', {
      details: { label },
    });
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new ReviewError('INVALID_INPUT', 'long-text output must be a regular file', { details: { label } });
  }
  const real = await realpath(filePath);
  if (!isWithin(outputsDir, real)) {
    throw new ReviewError('INVALID_INPUT', 'long-text output escapes the outputs directory', {
      details: { label },
    });
  }
  if (stats.size > options.maxOutputBytes) {
    throw new ReviewError('PAYLOAD_TOO_LARGE', 'long-text output is larger than the readable limit', {
      details: { label, bytes: stats.size, limit: options.maxOutputBytes },
    });
  }
  return readFile(real, 'utf8');
}

async function resolveOutputsDir(runDir: string): Promise<string> {
  const candidate = join(runDir, 'outputs');
  const stats = await lstatOrUndefined(candidate);
  if (stats === undefined) {
    throw new ReviewError('RUN_NOT_EXPORTABLE', 'run references extracted text but its outputs directory is missing');
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new ReviewError('INVALID_INPUT', 'run outputs must be a plain directory');
  }
  const real = await realpath(candidate);
  if (!isWithin(runDir, real)) {
    throw new ReviewError('INVALID_INPUT', 'run outputs escape the run directory');
  }
  return real;
}

function assertSafeLabel(label: string): void {
  if (
    label === '' ||
    label === '.' ||
    label.includes('..') ||
    label.includes('/') ||
    label.includes('\\') ||
    CONTROL_CHARACTERS.test(label)
  ) {
    throw new ReviewError('INVALID_INPUT', 'long-text reference contains an unsafe label', {
      details: { label },
    });
  }
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
