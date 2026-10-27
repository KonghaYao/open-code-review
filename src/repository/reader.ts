// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
import { ReviewError } from '../domain/errors.js';
import type {
  ReadFileRequest,
  ReadFileResult,
  ReadLinesRequest,
  ReadLinesResult,
  Reader,
  SearchMatch,
  SearchRequest,
  SearchResult,
} from '../domain/interfaces.js';
import type { ReviewSource } from '../domain/types.js';
import { decodePrefix, isBinaryContent, splitContentLines } from '../git/content.js';
import { digestLines } from '../git/hash.js';
import { isObjectId, normalizeRepoPath } from '../git/paths.js';
import type { RepositoryContext } from './context.js';
import { SourceContent, assertChangeSide } from './content.js';
import { isProviderPath, isSecretPath } from './exclusions.js';
import { assertSourceOwner } from './source.js';

const DEFAULT_SEARCH_LIMIT = 100;
const MAX_SEARCH_LIMIT = 1000;
const EXCERPT_LENGTH = 240;

/**
 * Read-only access to the resolved Git input. Fixed sides are served from git
 * objects at the recorded SHAs; the workspace side reads the live worktree
 * after the fingerprint is re-verified.
 */
export class GitReader implements Reader {
  private readonly context: RepositoryContext;
  private readonly content: SourceContent;

  constructor(context: RepositoryContext) {
    this.context = context;
    this.content = new SourceContent(context);
  }

  async readFile(request: ReadFileRequest): Promise<ReadFileResult> {
    await this.prepareSource(request.source);
    const side = assertChangeSide(request.side);
    const path = normalizeRepoPath(request.path);
    const loaded = await this.content.load(request.source, path, side);
    if (loaded === undefined) {
      throw new ReviewError('INVALID_INPUT', `path is not part of the resolved ${side} source: ${path}`);
    }

    const maxBytes = positiveOr(request.maxBytes, this.context.options.maxFileBytes);
    const binary = isBinaryContent(loaded.bytes);
    return {
      path,
      side,
      text: binary ? '' : decodePrefix(loaded.bytes, maxBytes),
      digest: loaded.digest,
      bytes: loaded.bytes.length,
      binary,
      truncated: loaded.bytes.length > maxBytes,
    };
  }

  async readLines(request: ReadLinesRequest): Promise<ReadLinesResult> {
    await this.prepareSource(request.source);
    const side = assertChangeSide(request.side);
    const path = normalizeRepoPath(request.path);
    const loaded = await this.content.load(request.source, path, side);
    if (loaded === undefined) {
      throw new ReviewError('INVALID_INPUT', `path is not part of the resolved ${side} source: ${path}`);
    }
    if (isBinaryContent(loaded.bytes)) {
      throw new ReviewError('BINARY_FILE', 'file is binary and cannot be read as text');
    }
    if (loaded.size > this.context.options.maxFileBytes) {
      throw new ReviewError('PAYLOAD_TOO_LARGE', 'file is larger than the readable limit');
    }
    const startLine = Number(request.startLine);
    const endLine = Number(request.endLine);
    if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) {
      throw new ReviewError('INVALID_INPUT', 'line range is invalid');
    }

    const lines = splitContentLines(loaded.bytes);
    const start = Math.min(startLine, lines.length + 1);
    const end = Math.min(Math.max(endLine, start - 1), lines.length);
    const slice = start <= end ? lines.slice(start - 1, end) : [];
    return {
      path,
      side,
      startLine: start,
      endLine: end,
      text: slice.join('\n'),
      digest: digestLines(slice),
    };
  }

  async search(request: SearchRequest): Promise<SearchResult> {
    await this.prepareSource(request.source);
    const side = assertChangeSide(request.side);
    const query = typeof request.query === 'string' ? request.query.trim() : '';
    if (query === '') {
      throw new ReviewError('INVALID_INPUT', 'query is required');
    }
    const maxResults = searchLimit(request.maxResults);
    const needle = query.toLowerCase();
    const candidates = await this.candidatePaths(request.source, side, request.paths);
    const matches: SearchMatch[] = [];
    const skippedFiles: string[] = [];

    for (const path of candidates) {
      if (matches.length >= maxResults) {
        break;
      }
      const loaded = await this.content.load(request.source, path, side);
      if (loaded === undefined || loaded.size > this.context.options.maxFileBytes || isBinaryContent(loaded.bytes)) {
        skippedFiles.push(path);
        continue;
      }
      const lines = splitContentLines(loaded.bytes);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? '';
        if (!line.toLowerCase().includes(needle)) {
          continue;
        }
        matches.push({ path, line: index + 1, text: excerpt(line) });
        if (matches.length >= maxResults) {
          break;
        }
      }
    }
    return { matches, skippedFiles };
  }

  private async prepareSource(source: ReviewSource): Promise<void> {
    await this.context.ready();
    assertSourceOwner(source, await this.context.repoId());
    await this.content.assertFresh(source);
  }

  private async candidatePaths(
    source: ReviewSource,
    side: 'base' | 'head' | 'workspace',
    requested: readonly string[] | undefined,
  ): Promise<string[]> {
    if (requested !== undefined) {
      const paths = new Set<string>();
      for (const raw of requested) {
        const path = normalizeRepoPath(typeof raw === 'string' ? raw : '');
        if (path === '') {
          throw new ReviewError('INVALID_INPUT', 'search paths must not be empty');
        }
        if (isSecretPath(path)) {
          throw new ReviewError('INVALID_INPUT', 'secret paths are never readable');
        }
        if (isProviderPath(path)) {
          throw new ReviewError('INVALID_INPUT', 'path is outside the reviewable source');
        }
        paths.add(path);
      }
      return [...paths].sort(compare);
    }

    if (side === 'workspace') {
      if (source.mode !== 'workspace') {
        throw new ReviewError('INVALID_INPUT', 'workspace side is only available for workspace reviews');
      }
      return (await this.context.git.listWorktreeFiles()).filter(
        (path) => !isSecretPath(path) && !isProviderPath(path),
      );
    }

    const revision = side === 'base' ? source.baseSha : source.headSha;
    if (revision === '' || !isObjectId(revision)) {
      throw new ReviewError('INVALID_INPUT', `the ${side} side has no revision for this source`);
    }
    return (await this.context.git.lsTree(revision))
      .filter((entry) => entry.type === 'blob' && !isSecretPath(entry.path) && !isProviderPath(entry.path))
      .map((entry) => entry.path)
      .sort(compare);
  }
}

function searchLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_SEARCH_LIMIT;
  }
  return Math.min(Math.floor(value), MAX_SEARCH_LIMIT);
}

function positiveOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function excerpt(line: string): string {
  const trimmed = line.trim();
  const characters = [...trimmed];
  return characters.length <= EXCERPT_LENGTH ? trimmed : characters.slice(0, EXCERPT_LENGTH).join('');
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
