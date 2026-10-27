// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { ReviewError } from '../domain/errors.js';
import type { ReviewSource } from '../domain/types.js';
import { isBinaryContent } from '../git/content.js';
import { compileGlob, matchesAnyGlob } from '../git/glob.js';
import { GitError, GitRunner } from '../git/runner.js';

import { normalizeRulePath } from './paths.js';

/** Same location and schema as the legacy Go implementation. */
export const PROJECT_RULE_PATH = '.opencodereview/rule.json';
export const PROJECT_RULE_MAX_BYTES = 1024 * 1024;

export interface ProjectRuleEntry {
  /** Declaration position; only used for diagnostics. */
  index: number;
  path: string;
  rule: string;
  mergeSystemRule: boolean;
}

export interface ProjectRules {
  rules: ProjectRuleEntry[];
  include: string[];
  exclude: string[];
}

export interface ProjectRuleLoadOptions {
  repoRoot: string;
  gitPath?: string;
  gitTimeoutMs?: number;
  maxBytes?: number;
  /** Test seam; production reads the fixed source through git or the worktree. */
  readProjectRule?: (source: ReviewSource) => Promise<string | undefined>;
}

/**
 * Parses `.opencodereview/rule.json`. Missing fields default the same way as
 * the Go resolver; types are checked because a malformed policy must fail
 * preparation instead of silently changing review behavior.
 */
export function parseProjectRules(text: string, label: string = PROJECT_RULE_PATH): ProjectRules | undefined {
  if (text.trim() === '') {
    return undefined;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ReviewError('PREPARATION_FAILED', `parse ${label}: invalid JSON`, { cause: error });
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ReviewError('PREPARATION_FAILED', `parse ${label}: the root must be an object`);
  }
  const record = raw as Record<string, unknown>;

  const include = stringList(record.include, `${label}: include`);
  const exclude = stringList(record.exclude, `${label}: exclude`);
  validatePatterns(include, label, 'include');
  validatePatterns(exclude, label, 'exclude');

  const rulesValue = record.rules;
  if (rulesValue !== undefined && rulesValue !== null && !Array.isArray(rulesValue)) {
    throw new ReviewError('PREPARATION_FAILED', `parse ${label}: rules must be an array`);
  }
  const rules: ProjectRuleEntry[] = [];
  if (Array.isArray(rulesValue)) {
    for (const [index, value] of rulesValue.entries()) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new ReviewError('PREPARATION_FAILED', `parse ${label}: rules[${index}] must be an object`);
      }
      const entry = value as Record<string, unknown>;
      if (typeof entry.path !== 'string' || entry.path.trim() === '') {
        throw new ReviewError('PREPARATION_FAILED', `parse ${label}: rules[${index}].path must be a non-empty string`);
      }
      if (entry.rule !== undefined && typeof entry.rule !== 'string') {
        throw new ReviewError('PREPARATION_FAILED', `parse ${label}: rules[${index}].rule must be a string`);
      }
      if (entry.merge_system_rule !== undefined && typeof entry.merge_system_rule !== 'boolean') {
        throw new ReviewError('PREPARATION_FAILED', `parse ${label}: rules[${index}].merge_system_rule must be a boolean`);
      }
      const path = entry.path.trim();
      validatePatterns([path], label, `rules[${index}].path`);
      const rule = typeof entry.rule === 'string' ? entry.rule : '';
      rules.push({
        index,
        path,
        rule,
        mergeSystemRule: entry.merge_system_rule === true,
      });
    }
  }

  return { rules, include, exclude };
}

export function projectRulesApply(project: ProjectRules, path: string): boolean {
  const normalized = normalizeRulePath(path);
  if (normalized === '') {
    return false;
  }
  if (project.include.length > 0 && !matchesAnyGlob(project.include.map(normalizeRulePath), normalized)) {
    return false;
  }
  if (project.exclude.length > 0 && matchesAnyGlob(project.exclude.map(normalizeRulePath), normalized)) {
    return false;
  }
  return true;
}

/** First enabled entry wins, mirroring the legacy resolver. */
export function matchProjectEntry(project: ProjectRules, path: string): ProjectRuleEntry | undefined {
  if (!projectRulesApply(project, path)) {
    return undefined;
  }
  const normalized = normalizeRulePath(path);
  for (const entry of project.rules) {
    if (entry.rule.trim() === '' && !entry.mergeSystemRule) {
      continue;
    }
    if (matchesAnyGlob([normalizeRulePath(entry.path)], normalized)) {
      return entry;
    }
  }
  return undefined;
}

export async function loadProjectRuleText(
  source: ReviewSource,
  options: ProjectRuleLoadOptions,
): Promise<string | undefined> {
  if (options.readProjectRule !== undefined) {
    return options.readProjectRule(source);
  }
  const maxBytes = options.maxBytes ?? PROJECT_RULE_MAX_BYTES;
  if (source.mode === 'workspace') {
    return readWorkspaceProjectRule(options.repoRoot, maxBytes);
  }
  return readGitProjectRule(source, options.repoRoot, maxBytes, options);
}

async function readWorkspaceProjectRule(repoRoot: string, maxBytes: number): Promise<string | undefined> {
  const target = join(repoRoot, PROJECT_RULE_PATH);
  let stats;
  try {
    stats = await stat(target);
  } catch (error) {
    if (isNotFound(error)) {
      return undefined;
    }
    throw new ReviewError('PREPARATION_FAILED', `unable to read ${PROJECT_RULE_PATH} from the workspace`, { cause: error });
  }
  if (!stats.isFile()) {
    throw new ReviewError('PREPARATION_FAILED', `${PROJECT_RULE_PATH} is not a regular file`);
  }
  if (stats.size > maxBytes) {
    throw new ReviewError('PREPARATION_FAILED', `${PROJECT_RULE_PATH} exceeds ${maxBytes} bytes`);
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(target);
  } catch (error) {
    throw new ReviewError('PREPARATION_FAILED', `unable to read ${PROJECT_RULE_PATH} from the workspace`, { cause: error });
  }
  return decodeProjectRule(bytes, `${PROJECT_RULE_PATH} in the workspace`, maxBytes);
}

async function readGitProjectRule(
  source: ReviewSource,
  repoRoot: string,
  maxBytes: number,
  options: ProjectRuleLoadOptions,
): Promise<string | undefined> {
  const runner = new GitRunner({ cwd: repoRoot, gitPath: options.gitPath, timeoutMs: options.gitTimeoutMs });
  const spec = `${source.headSha}:${PROJECT_RULE_PATH}`;
  let bytes: Buffer;
  try {
    bytes = await runner.runBuffer(['show', spec]);
  } catch (error) {
    if (error instanceof GitError && error.kind === 'failed' && isMissingPath(error.message)) {
      return undefined;
    }
    throw new ReviewError('PREPARATION_FAILED', `unable to read ${PROJECT_RULE_PATH} at ${source.headSha}`, { cause: error });
  }
  return decodeProjectRule(bytes, `${PROJECT_RULE_PATH} at ${source.headSha}`, maxBytes);
}

function decodeProjectRule(bytes: Uint8Array, label: string, maxBytes: number): string | undefined {
  if (bytes.length > maxBytes) {
    throw new ReviewError('PREPARATION_FAILED', `${label} exceeds ${maxBytes} bytes`);
  }
  if (isBinaryContent(bytes)) {
    throw new ReviewError('PREPARATION_FAILED', `${label} is binary`);
  }
  const text = Buffer.from(bytes).toString('utf8');
  return text.trim() === '' ? undefined : text;
}

function validatePatterns(patterns: readonly string[], label: string, field: string): void {
  for (const pattern of patterns) {
    try {
      compileGlob(normalizeRulePath(pattern));
    } catch (error) {
      throw new ReviewError('PREPARATION_FAILED', `parse ${label}: invalid glob in ${field}: ${pattern}`, { cause: error });
    }
  }
}

function stringList(value: unknown, field: string): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new ReviewError('PREPARATION_FAILED', `parse ${field}: must be an array`);
  }
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') {
      throw new ReviewError('PREPARATION_FAILED', `parse ${field}: must contain strings`);
    }
    const trimmed = item.trim();
    if (trimmed !== '') {
      result.push(trimmed);
    }
  }
  return result;
}

function isMissingPath(message: string): boolean {
  return /does not exist in|exists on disk, but not in/iu.test(message);
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT';
}
