// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
import { readFileSync } from 'node:fs';

import { resolveAssetPath } from '../assets.js';
import { ReviewError } from '../domain/errors.js';
import { compileGlob } from '../git/glob.js';
import { canonicalHash } from '../git/hash.js';

export const SYSTEM_RULES_ASSET = 'rules/system-rules.json';
export const SYSTEM_RULE_FORMAT_VERSION = 1;

export const PATH_CATEGORIES = ['source', 'test', 'config', 'ci', 'docs', 'build', 'dependency', 'unknown'] as const;
export type PathCategory = (typeof PATH_CATEGORIES)[number];

export const CHANGE_KINDS = ['modified', 'deleted'] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

export const RULE_APPLIES_TO = ['file', 'cross_file', 'both'] as const;
export type RuleAppliesTo = (typeof RULE_APPLIES_TO)[number];

export interface SystemRule {
  id: string;
  area: string;
  description?: string;
  appliesTo: RuleAppliesTo;
  languages: string[];
  pathCategories: PathCategory[];
  patterns: string[];
  changeKinds: ChangeKind[];
  checks: string[];
}

export interface FallbackRule {
  area: string;
  checks: string[];
}

/**
 * A validated system catalog. Rule and check order are semantic: they decide
 * the order of the returned checks, so the digest covers arrays as authored.
 */
export interface SystemRuleCatalog {
  formatVersion: number;
  version: string;
  fallback: FallbackRule;
  rules: SystemRule[];
}

/** Stable identity of one catalog, independent of JSON formatting. */
export function computeRulesDigest(catalog: SystemRuleCatalog): string {
  return canonicalHash(catalog);
}

/**
 * Loads the catalog shipped inside the npm package. The file is read rather
 * than imported so a missing or invalid asset fails with a rule-specific error
 * instead of a module loader failure.
 */
export function loadBundledSystemCatalog(moduleUrl: string | URL = import.meta.url): SystemRuleCatalog {
  let text: string;
  try {
    text = readFileSync(resolveAssetPath(SYSTEM_RULES_ASSET, moduleUrl), 'utf8');
  } catch (error) {
    throw new ReviewError('ASSET_NOT_FOUND', `unable to read ${SYSTEM_RULES_ASSET}`, { cause: error });
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ReviewError('PREPARATION_FAILED', `invalid JSON in ${SYSTEM_RULES_ASSET}`, { cause: error });
  }
  return parseSystemRuleCatalog(raw);
}

export function parseSystemRuleCatalog(raw: unknown): SystemRuleCatalog {
  if (!isRecord(raw)) {
    fail('the catalog must be a JSON object');
  }
  if (raw.formatVersion !== SYSTEM_RULE_FORMAT_VERSION) {
    fail(`formatVersion must be ${SYSTEM_RULE_FORMAT_VERSION}`);
  }
  const version = requiredString(raw.version, 'version');
  const fallback = parseFallback(raw.fallback);
  const rulesValue = raw.rules;
  if (!Array.isArray(rulesValue) || rulesValue.length === 0) {
    fail('rules must be a non-empty array');
  }

  const seen = new Set<string>();
  const rules: SystemRule[] = [];
  for (const [index, value] of rulesValue.entries()) {
    const rule = parseRule(value, `rules[${index}]`);
    if (seen.has(rule.id)) {
      fail(`duplicate rule id: ${rule.id}`);
    }
    seen.add(rule.id);
    rules.push(rule);
  }

  return { formatVersion: SYSTEM_RULE_FORMAT_VERSION, version, fallback, rules };
}

function parseFallback(value: unknown): FallbackRule {
  if (!isRecord(value)) {
    fail('fallback must be an object');
  }
  return {
    area: requiredString(value.area, 'fallback.area'),
    checks: stringList(value.checks, 'fallback.checks', { required: true }),
  };
}

function parseRule(value: unknown, field: string): SystemRule {
  if (!isRecord(value)) {
    fail(`${field} must be an object`);
  }
  const id = requiredString(value.id, `${field}.id`);
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(id)) {
    fail(`${field}.id must match ^[a-z0-9][a-z0-9-]*$`);
  }
  if (id === 'fallback') {
    fail(`${field}.id "fallback" is reserved for the generic checks`);
  }
  const area = requiredString(value.area, `${field}.area`);
  const appliesTo = optionalEnum(value.appliesTo, RULE_APPLIES_TO, `${field}.appliesTo`, 'both');
  const languages = uniqueLower(stringList(value.languages, `${field}.languages`));
  const pathCategories = optionalEnumList(value.pathCategories, PATH_CATEGORIES, `${field}.pathCategories`);
  const patterns: string[] = [];
  const seenPatterns = new Set<string>();
  for (const pattern of stringList(value.patterns, `${field}.patterns`)) {
    const normalized = validatePattern(field, pattern);
    if (!seenPatterns.has(normalized)) {
      seenPatterns.add(normalized);
      patterns.push(normalized);
    }
  }
  const changeKinds = optionalEnumList(value.changeKinds, CHANGE_KINDS, `${field}.changeKinds`);
  const checks = stringList(value.checks, `${field}.checks`, { required: true });

  if (appliesTo !== 'cross_file' && languages.length === 0 && pathCategories.length === 0 && patterns.length === 0 && changeKinds.length === 0) {
    fail(`${field} must declare at least one selector when it applies to file units`);
  }

  const rule: SystemRule = {
    id,
    area,
    appliesTo,
    languages,
    pathCategories,
    patterns,
    changeKinds,
    checks,
  };
  const description = optionalString(value.description);
  if (description !== undefined) {
    rule.description = description;
  }
  return rule;
}

function validatePattern(field: string, pattern: string): string {
  const normalized = pattern.toLowerCase();
  try {
    compileGlob(normalized);
  } catch (error) {
    throw new ReviewError('PREPARATION_FAILED', `invalid glob in ${field}.patterns: ${pattern}`, { cause: error });
  }
  return normalized;
}

function uniqueLower(values: readonly string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = value.toLowerCase();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return result;
}

function optionalEnumList<const T extends readonly string[]>(value: unknown, allowed: T, field: string): T[number][] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    fail(`${field} must be an array`);
  }
  const result: T[number][] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string' || !allowed.includes(item)) {
      fail(`${field} contains an unsupported value: ${String(item)}`);
    }
    if (!seen.has(item)) {
      seen.add(item);
      result.push(item as T[number]);
    }
  }
  return result;
}

function optionalEnum<const T extends readonly string[]>(value: unknown, allowed: T, field: string, fallback: T[number]): T[number] {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'string' || !allowed.includes(value)) {
    fail(`${field} must be one of ${allowed.join(', ')}`);
  }
  return value as T[number];
}

function stringList(value: unknown, field: string, options: { required?: boolean } = {}): string[] {
  if (value === undefined) {
    if (options.required === true) {
      fail(`${field} must be a non-empty array`);
    }
    return [];
  }
  if (!Array.isArray(value)) {
    fail(`${field} must be an array`);
  }
  if (options.required === true && value.length === 0) {
    fail(`${field} must be a non-empty array`);
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '') {
      fail(`${field} must contain non-empty strings`);
    }
    const text = item.trim();
    if (!seen.has(text)) {
      seen.add(text);
      result.push(text);
    }
  }
  return result;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    fail('description must be a non-empty string when present');
  }
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new ReviewError('PREPARATION_FAILED', `invalid system rule catalog: ${message}`);
}
