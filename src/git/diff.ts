// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
import { Buffer } from 'node:buffer';

import { splitContentLines } from './content.js';

export type ChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied';

export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  /** The literal `@@ ... @@` line, used as part of a unit id. */
  header: string;
  /** Raw diff lines, each keeping its `+`, `-` or space prefix. */
  lines: string[];
}

export interface DiffBlock {
  oldPath: string;
  newPath: string;
  status: ChangeStatus;
  binary: boolean;
  insertions: number;
  deletions: number;
  hunks: DiffHunk[];
  text: string;
  truncated: boolean;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u;
const NO_NEWLINE_MARKER = '\\ No newline at end of file';

/**
 * Splits machine-generated `git diff` output into per-file blocks. Text before
 * the first `diff --git` header is ignored, and a block larger than maxBytes is
 * cut on a line boundary and marked truncated instead of being dropped.
 */
export function parseUnifiedDiff(text: string, maxBytes: number): DiffBlock[] {
  const lines = splitDiffText(text);
  const blocks: DiffBlock[] = [];
  let current: string[] | undefined;

  const flush = (): void => {
    if (current === undefined || current.length === 0) {
      current = undefined;
      return;
    }
    blocks.push(parseDiffBlock(current, maxBytes));
    current = undefined;
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flush();
      current = [line];
      continue;
    }
    if (current === undefined) {
      continue;
    }
    current.push(line);
  }
  flush();
  return blocks;
}

function splitDiffText(text: string): string[] {
  if (text === '') {
    return [];
  }
  const lines = text.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

function parseDiffBlock(rawLines: string[], maxBytes: number): DiffBlock {
  const truncatedBlock = truncateDiffLines(rawLines, maxBytes);
  const lines = truncatedBlock.lines;
  const block: DiffBlock = {
    oldPath: '',
    newPath: '',
    status: 'modified',
    binary: false,
    insertions: 0,
    deletions: 0,
    hunks: [],
    text: lines.join('\n'),
    truncated: truncatedBlock.truncated,
  };

  let headerOld = '';
  let headerNew = '';
  let renameFrom = '';
  let renameTo = '';
  let copyFrom = '';
  let copyTo = '';
  let explicitStatus: ChangeStatus | undefined;

  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined) {
      break;
    }
    if (index === 0) {
      const paths = parseDiffHeaderPaths(line);
      headerOld = paths[0];
      headerNew = paths[1];
      index += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      const hunk = parseHunkHeader(line);
      index += 1;
      if (hunk === undefined) {
        continue;
      }
      while (index < lines.length) {
        const next = lines[index];
        if (next === undefined) {
          break;
        }
        if (next.startsWith('@@') || next.startsWith('diff --git ')) {
          break;
        }
        index += 1;
        if (next === '') {
          continue;
        }
        if (next.startsWith(NO_NEWLINE_MARKER)) {
          // Metadata, not content: keeping it would advance the new-side line
          // counter and shift every later unit line.
          continue;
        }
        hunk.lines.push(next);
        if (next.startsWith('+')) {
          block.insertions += 1;
        } else if (next.startsWith('-')) {
          block.deletions += 1;
        }
      }
      block.hunks.push(hunk);
      continue;
    }

    if (line.startsWith('new file mode ')) {
      explicitStatus = 'added';
    } else if (line.startsWith('deleted file mode ')) {
      explicitStatus = 'deleted';
    } else if (line.startsWith('rename from ')) {
      renameFrom = parseGitPath(line.slice('rename from '.length));
      explicitStatus = 'renamed';
    } else if (line.startsWith('rename to ')) {
      renameTo = parseGitPath(line.slice('rename to '.length));
      explicitStatus = 'renamed';
    } else if (line.startsWith('copy from ')) {
      copyFrom = parseGitPath(line.slice('copy from '.length));
      explicitStatus = 'copied';
    } else if (line.startsWith('copy to ')) {
      copyTo = parseGitPath(line.slice('copy to '.length));
      explicitStatus = 'copied';
    } else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      block.binary = true;
    } else if (line.startsWith('--- ')) {
      headerOld = parsePrefixedPath(line.slice('--- '.length), 'a/');
    } else if (line.startsWith('+++ ')) {
      headerNew = parsePrefixedPath(line.slice('+++ '.length), 'b/');
    }
    index += 1;
  }

  let oldPath = headerOld;
  let newPath = headerNew;
  if (renameFrom !== '' || renameTo !== '') {
    oldPath = renameFrom;
    newPath = renameTo;
  } else if (copyFrom !== '' || copyTo !== '') {
    oldPath = copyFrom;
    newPath = copyTo;
  }

  let status: ChangeStatus = explicitStatus ?? 'modified';
  if (explicitStatus === undefined) {
    if (oldPath === '' && newPath !== '') {
      status = 'added';
    } else if (newPath === '' && oldPath !== '') {
      status = 'deleted';
    }
  }
  // Binary blocks carry no ---/+++ lines, so /dev/null is only visible from the
  // mode header that accompanies an add or a delete.
  if (status === 'added') {
    oldPath = '';
  } else if (status === 'deleted') {
    newPath = '';
  }
  if (oldPath === '' && newPath === '') {
    oldPath = headerOld;
    newPath = headerNew;
  }

  block.oldPath = oldPath;
  block.newPath = newPath;
  block.status = status;
  return block;
}

function parseHunkHeader(line: string): DiffHunk | undefined {
  const match = HUNK_HEADER.exec(line);
  if (match === null) {
    return undefined;
  }
  return {
    oldStart: Number(match[1]),
    oldCount: match[2] === undefined ? 1 : Number(match[2]),
    newStart: Number(match[3]),
    newCount: match[4] === undefined ? 1 : Number(match[4]),
    header: line,
    lines: [],
  };
}

function truncateDiffLines(lines: string[], maxBytes: number): { lines: string[]; truncated: boolean } {
  if (maxBytes <= 0) {
    return { lines, truncated: false };
  }
  let total = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    total += Buffer.byteLength(line, 'utf8') + 1;
    if (total > maxBytes) {
      return { lines: index === 0 ? lines.slice(0, 1) : lines.slice(0, index), truncated: true };
    }
  }
  return { lines, truncated: false };
}

/** Extracts both pathnames from a `diff --git` line. */
function parseDiffHeaderPaths(line: string): [string, string] {
  const rest = line.startsWith('diff --git ') ? line.slice('diff --git '.length) : line;
  const split = splitHeaderPaths(rest);
  if (split !== undefined) {
    return [trimDiffPrefix(split[0], 'a/'), trimDiffPrefix(split[1], 'b/')];
  }
  const index = rest.indexOf(' b/');
  if (index > 0 && rest.startsWith('a/')) {
    return [rest.slice(2, index), rest.slice(index + 3)];
  }
  return ['', ''];
}

function parsePrefixedPath(field: string, prefix: string): string {
  const path = parseGitPath(field.trim());
  if (path === '/dev/null') {
    return '';
  }
  return trimDiffPrefix(path, prefix);
}

/** Removes one side prefix; the other side is a fallback for names that begin with it. */
function trimDiffPrefix(path: string, prefix: string): string {
  if (path.startsWith(prefix)) {
    return path.slice(prefix.length);
  }
  const other = prefix === 'b/' ? 'a/' : 'b/';
  if (path.startsWith(other)) {
    return path.slice(other.length);
  }
  return path;
}

function parseGitPath(field: string): string {
  const trimmed = field.trim();
  if (trimmed === '') {
    return '';
  }
  if (trimmed.startsWith('"')) {
    const unquoted = unquoteGitPath(trimmed);
    return unquoted === undefined ? trimmed : unquoted.path;
  }
  const tab = trimmed.indexOf('\t');
  return (tab >= 0 ? trimmed.slice(0, tab) : trimmed).trim();
}

export interface UnquotedPath {
  path: string;
  rest: string;
}

/**
 * Decodes one C-style quoted pathname. Decoding is byte-oriented because a
 * multibyte character arrives as one octal escape per byte and only
 * reassembles once those bytes sit next to each other again.
 */
export function unquoteGitPath(input: string): UnquotedPath | undefined {
  if (!input.startsWith('"')) {
    return undefined;
  }
  const bytes: number[] = [];
  let index = 1;
  while (index < input.length) {
    const codePoint = input.codePointAt(index);
    if (codePoint === undefined) {
      return undefined;
    }
    const character = String.fromCodePoint(codePoint);
    index += character.length;
    if (character === '"') {
      return { path: Buffer.from(bytes).toString('utf8'), rest: input.slice(index) };
    }
    if (character !== '\\') {
      for (const byte of Buffer.from(character, 'utf8')) {
        bytes.push(byte);
      }
      continue;
    }
    const escape = input[index];
    index += 1;
    switch (escape) {
      case 'a':
        bytes.push(0x07);
        break;
      case 'b':
        bytes.push(0x08);
        break;
      case 'f':
        bytes.push(0x0c);
        break;
      case 'n':
        bytes.push(0x0a);
        break;
      case 'r':
        bytes.push(0x0d);
        break;
      case 't':
        bytes.push(0x09);
        break;
      case 'v':
        bytes.push(0x0b);
        break;
      case '"':
      case '\\':
        bytes.push(escape.charCodeAt(0));
        break;
      case '0':
      case '1':
      case '2':
      case '3':
      case '4':
      case '5':
      case '6':
      case '7': {
        const digits = input.slice(index - 1, index + 2);
        if (digits.length !== 3 || !/^[0-7]{3}$/u.test(digits)) {
          return undefined;
        }
        const value = Number.parseInt(digits, 8);
        if (value > 0xff) {
          return undefined;
        }
        bytes.push(value);
        index += 2;
        break;
      }
      default:
        return undefined;
    }
  }
  return undefined;
}

/**
 * Splits the text after `diff --git ` into its two pathnames, each still
 * carrying its `a/` or `b/` prefix. A bare name cannot contain a double quote,
 * so the first quote after a space opens the second name.
 */
function splitHeaderPaths(rest: string): [string, string] | undefined {
  if (rest.startsWith('"')) {
    const first = unquoteGitPath(rest);
    if (first === undefined || !first.rest.startsWith(' ')) {
      return undefined;
    }
    const after = first.rest.slice(1);
    if (after.startsWith('"')) {
      const second = unquoteGitPath(after);
      if (second === undefined || second.rest !== '') {
        return undefined;
      }
      return [first.path, second.path];
    }
    return [first.path, after];
  }
  const quote = rest.indexOf('"');
  if (quote <= 0 || rest[quote - 1] !== ' ') {
    return undefined;
  }
  const second = unquoteGitPath(rest.slice(quote));
  if (second === undefined || second.rest !== '') {
    return undefined;
  }
  return [rest.slice(0, quote - 1), second.path];
}

/**
 * Emits a C-quoted pathname when the raw characters cannot survive a single
 * diff header line, so synthetic blocks round-trip through the same parser git
 * output uses.
 */
export function quoteGitPath(path: string): string {
  const bytes = Buffer.from(path, 'utf8');
  let needsQuote = false;
  for (const byte of bytes) {
    if (byte < 0x20 || byte === 0x7f || byte === 0x22 || byte === 0x5c) {
      needsQuote = true;
      break;
    }
  }
  if (!needsQuote) {
    return path;
  }

  let quoted = '"';
  for (const character of path) {
    switch (character) {
      case '\u0007':
        quoted += '\\a';
        break;
      case '\b':
        quoted += '\\b';
        break;
      case '\f':
        quoted += '\\f';
        break;
      case '\n':
        quoted += '\\n';
        break;
      case '\r':
        quoted += '\\r';
        break;
      case '\t':
        quoted += '\\t';
        break;
      case '\v':
        quoted += '\\v';
        break;
      case '"':
        quoted += '\\"';
        break;
      case '\\':
        quoted += '\\\\';
        break;
      default: {
        const code = character.codePointAt(0) ?? 0;
        if (code < 0x20 || code === 0x7f) {
          quoted += `\\${code.toString(8).padStart(3, '0')}`;
        } else {
          quoted += character;
        }
      }
    }
  }
  return `${quoted}"`;
}

/** Builds the diff git would emit for a new untracked text file. */
export function buildAddDiff(path: string, bytes: Uint8Array): string {
  const lines = splitContentLines(bytes);
  const header = [
    `diff --git ${quoteGitPath(`a/${path}`)} ${quoteGitPath(`b/${path}`)}`,
    'new file mode 100644',
    '--- /dev/null',
    `+++ ${quoteGitPath(`b/${path}`)}`,
  ];
  if (lines.length === 0) {
    return header.join('\n');
  }
  const body = [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`)];
  return [...header, ...body].join('\n');
}

/** Builds the binary marker git emits for a new untracked binary file. */
export function buildBinaryAddDiff(path: string): string {
  return [
    `diff --git ${quoteGitPath(`a/${path}`)} ${quoteGitPath(`b/${path}`)}`,
    'new file mode 100644',
    `Binary files /dev/null and ${quoteGitPath(`b/${path}`)} differ`,
  ].join('\n');
}
