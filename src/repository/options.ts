// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
import type { RuleRef } from '../domain/types.js';
import { digestBytes } from '../git/hash.js';
import type { ManifestIdentity } from './manifest.js';

/** Selection rules supplied by the rules module; the repository only stores refs. */
export interface PlanningHooks {
  ruleRefsForPath?: (path: string) => RuleRef[];
  relatedPathsForPath?: (path: string) => string[];
}

export interface RepositoryIdentityOptions {
  rulesDigest?: string;
  skillDigests?: Record<string, string>;
  serverVersion?: string;
}

export interface RepositoryOptions {
  /** Per-file diff text cap; longer blocks are truncated on a line boundary. */
  maxDiffBytes?: number;
  /** Files larger than this are excluded and never loaded as review input. */
  maxFileBytes?: number;
  /** Units returned per `prepare_code_review` page. */
  pageSize?: number;
  gitTimeoutMs?: number;
  gitMaxBufferBytes?: number;
  gitMaxConcurrent?: number;
  gitPath?: string;
  identity?: RepositoryIdentityOptions;
  planning?: PlanningHooks;
}

export interface ResolvedRepositoryOptions {
  maxDiffBytes: number;
  maxFileBytes: number;
  pageSize: number;
  gitTimeoutMs: number;
  gitMaxBufferBytes: number;
  gitMaxConcurrent: number;
  gitPath: string;
  identity: ManifestIdentity;
  planning: PlanningHooks;
}

export const DEFAULT_MAX_DIFF_BYTES = 4 * 1024 * 1024;
export const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const DEFAULT_PAGE_SIZE = 100;

export function resolveRepositoryOptions(options: RepositoryOptions = {}): ResolvedRepositoryOptions {
  return {
    maxDiffBytes: positiveOr(options.maxDiffBytes, DEFAULT_MAX_DIFF_BYTES),
    maxFileBytes: positiveOr(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES),
    pageSize: positiveOr(options.pageSize, DEFAULT_PAGE_SIZE),
    gitTimeoutMs: positiveOr(options.gitTimeoutMs, 120_000),
    gitMaxBufferBytes: positiveOr(options.gitMaxBufferBytes, 64 * 1024 * 1024),
    gitMaxConcurrent: positiveOr(options.gitMaxConcurrent, 8),
    gitPath: options.gitPath ?? 'git',
    identity: {
      rulesDigest: options.identity?.rulesDigest ?? digestBytes('peri-code-review:no-rules'),
      skillDigests: { ...(options.identity?.skillDigests ?? {}) },
      serverVersion: options.identity?.serverVersion ?? '0.0.0',
    },
    planning: { ...(options.planning ?? {}) },
  };
}

function positiveOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}
