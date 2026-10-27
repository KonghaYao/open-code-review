// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
const BINARY_PROBE_BYTES = 8000;

/** Follows git's own heuristic: a NUL byte early in the content. */
export function isBinaryContent(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, BINARY_PROBE_BYTES);
  for (let index = 0; index < limit; index += 1) {
    if (bytes[index] === 0) {
      return true;
    }
  }
  return false;
}

/**
 * Splits content into display lines: the trailing newline does not create an
 * extra empty line and CRLF endings are folded to LF so line numbers agree
 * with what a model sees.
 */
export function splitContentLines(bytes: Uint8Array): string[] {
  if (bytes.length === 0) {
    return [];
  }
  let text = Buffer.from(bytes).toString('utf8');
  if (text.endsWith('\n')) {
    text = text.slice(0, -1);
  }
  return text.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

/** Decodes at most maxBytes without splitting a UTF-8 sequence. */
export function decodePrefix(bytes: Uint8Array, maxBytes: number): string {
  if (bytes.length <= maxBytes) {
    return Buffer.from(bytes).toString('utf8');
  }
  let end = Math.max(0, Math.min(maxBytes, bytes.length));
  while (end > 0 && end < bytes.length) {
    const byte = bytes[end];
    if (byte === undefined || (byte & 0xc0) !== 0x80) {
      break;
    }
    end -= 1;
  }
  return Buffer.from(bytes.subarray(0, end)).toString('utf8');
}
