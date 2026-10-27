// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
import { createHash } from 'node:crypto';

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function digestBytes(data: string | Uint8Array): string {
  return `sha256:${sha256Hex(data)}`;
}

/**
 * Short identity hash used by change and unit ids. Every part is terminated by
 * a NUL so that ("ab", "c") and ("a", "bc") cannot collide.
 */
export function shortHash(...parts: string[]): string {
  const hash = createHash('sha256');
  for (const part of parts) {
    hash.update(part);
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}

/** Stable JSON with object keys sorted, so digests do not depend on key order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function canonicalHash(value: unknown): string {
  return digestBytes(canonicalJson(value));
}

/** Hashes normalized line content; trailing whitespace is not semantic. */
export function digestLines(lines: readonly string[]): string {
  return digestBytes(lines.map((line) => line.replace(/[ \t\r]+$/u, '')).join('\n'));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }
  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    const item = source[key];
    if (item === undefined) {
      continue;
    }
    sorted[key] = canonicalize(item);
  }
  return sorted;
}
