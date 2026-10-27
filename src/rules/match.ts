// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
import type { ReviewCheck, ReviewUnit, UnitKind, UnitReviewArea } from '../domain/types.js';
import { matchesAnyGlob } from '../git/glob.js';
import { shortHash } from '../git/hash.js';

import type { ChangeKind, SystemRule, SystemRuleCatalog } from './catalog.js';
import { classifyPath, detectLanguage, normalizeRulePath } from './paths.js';
import { matchProjectEntry, type ProjectRuleEntry, type ProjectRules } from './project.js';

export const FALLBACK_RULE_ID = 'system:fallback';
export const PROJECT_AREA = 'project';

const AREA_ORDER: readonly string[] = [
  'correctness',
  'security',
  'performance',
  'maintainability',
  'testing',
  'redundancy',
  'cross-file',
  'project',
  'general',
];

export interface RuleMatchContext {
  path: string;
  unitKind: UnitKind;
  changeKind: ChangeKind;
}

export function systemRuleId(rule: SystemRule): string {
  return `system:${rule.id}`;
}

export function projectRuleId(entry: ProjectRuleEntry): string {
  return `project:${entry.path}`;
}

/**
 * A stable checkpoint identity. It deliberately excludes the unit and path so
 * the same check has the same ID across every unit it applies to.
 */
export function checkIdFor(ruleId: string, text: string): string {
  return `chk_${shortHash(ruleId, text)}`;
}

/**
 * A unit does not carry the original diff status. `side: "base"` is the only
 * reliable deletion signal; cross-file units always describe a mixed change.
 */
export function unitChangeKind(unit: ReviewUnit): ChangeKind {
  return unit.kind === 'file' && unit.side === 'base' ? 'deleted' : 'modified';
}

export function ruleMatches(rule: SystemRule, context: RuleMatchContext): boolean {
  if (context.unitKind === 'file' && rule.appliesTo === 'cross_file') {
    return false;
  }
  if (context.unitKind === 'cross_file' && rule.appliesTo === 'file') {
    return false;
  }
  if (rule.changeKinds.length > 0 && !rule.changeKinds.includes(context.changeKind)) {
    return false;
  }
  if (rule.languages.length > 0 && !rule.languages.includes(detectLanguage(context.path))) {
    return false;
  }
  if (rule.pathCategories.length > 0 && !rule.pathCategories.includes(classifyPath(context.path))) {
    return false;
  }
  if (rule.patterns.length > 0 && !matchesAnyGlob(rule.patterns, normalizeRulePath(context.path))) {
    return false;
  }
  return true;
}

export interface MatchedSystemRule {
  rule: SystemRule;
  ruleId: string;
  checks: ReviewCheck[];
}

export function matchSystemRules(catalog: SystemRuleCatalog, context: RuleMatchContext): MatchedSystemRule[] {
  const matched: MatchedSystemRule[] = [];
  for (const rule of catalog.rules) {
    if (!ruleMatches(rule, context)) {
      continue;
    }
    const ruleId = systemRuleId(rule);
    matched.push({
      rule,
      ruleId,
      checks: rule.checks.map((text) => ({ checkId: checkIdFor(ruleId, text), ruleId, text })),
    });
  }
  return matched;
}

/**
 * Project guidance is free text, so each paragraph becomes one checkpoint. A
 * check ID is stable for the same rule and paragraph text.
 */
export function projectCheckTexts(text: string): string[] {
  return text
    .replace(/\r\n/gu, '\n')
    .split(/\n[ \t]*\n/u)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== '');
}

export function buildProjectChecks(entry: ProjectRuleEntry): ReviewCheck[] {
  const ruleId = projectRuleId(entry);
  return projectCheckTexts(entry.rule).map((text) => ({ checkId: checkIdFor(ruleId, text), ruleId, text }));
}

export interface BuildAreaParams {
  unit: ReviewUnit;
  catalog: SystemRuleCatalog;
  project: ProjectRules | undefined;
  rulesDigest: string;
}

/**
 * Resolves one unit to areas, checks and rule identities. A unit with no match
 * receives the generic fallback checks with `fallback: true`; an empty rule set
 * is never reported as "nothing to review".
 */
export function buildUnitReviewArea(params: BuildAreaParams): UnitReviewArea {
  const { unit, catalog, project, rulesDigest } = params;
  const changeKind = unitChangeKind(unit);
  const paths = [...new Set(unit.paths.map(normalizeRulePath).filter((path) => path !== ''))].sort(compare);

  const checks: ReviewCheck[] = [];
  const seenChecks = new Set<string>();
  const areas = new Set<string>();
  const ruleIds = new Set<string>();

  const addChecks = (list: readonly ReviewCheck[]): void => {
    for (const check of list) {
      if (seenChecks.has(check.checkId)) {
        continue;
      }
      seenChecks.add(check.checkId);
      checks.push(check);
      ruleIds.add(check.ruleId);
    }
  };

  for (const path of paths) {
    const systemMatches = matchSystemRules(catalog, { path, unitKind: unit.kind, changeKind });
    const entry = project === undefined ? undefined : matchProjectEntry(project, path);
    const projectMatches = entry === undefined ? [] : buildProjectChecks(entry);

    if (entry !== undefined && !entry.mergeSystemRule) {
      // A project entry without merge replaces the system checks for this path.
      addChecks(projectMatches);
      if (projectMatches.length > 0) {
        areas.add(PROJECT_AREA);
      }
      continue;
    }

    for (const match of systemMatches) {
      addChecks(match.checks);
      if (match.checks.length > 0) {
        areas.add(match.rule.area);
      }
    }
    if (projectMatches.length > 0) {
      addChecks(projectMatches);
      areas.add(PROJECT_AREA);
    }
  }

  if (checks.length === 0) {
    return {
      unitId: unit.unitId,
      areas: [catalog.fallback.area],
      checks: catalog.fallback.checks.map((text) => ({
        checkId: checkIdFor(FALLBACK_RULE_ID, text),
        ruleId: FALLBACK_RULE_ID,
        text,
      })),
      ruleIds: [FALLBACK_RULE_ID],
      rulesDigest,
      fallback: true,
    };
  }

  return {
    unitId: unit.unitId,
    areas: [...areas].sort(compareAreas),
    checks,
    ruleIds: [...ruleIds].sort(compare),
    rulesDigest,
  };
}

function compareAreas(left: string, right: string): number {
  const leftIndex = AREA_ORDER.indexOf(left);
  const rightIndex = AREA_ORDER.indexOf(right);
  if (leftIndex !== rightIndex) {
    if (leftIndex === -1) {
      return 1;
    }
    if (rightIndex === -1) {
      return -1;
    }
    return leftIndex - rightIndex;
  }
  return compare(left, right);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
