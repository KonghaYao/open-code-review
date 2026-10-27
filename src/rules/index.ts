// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
import type { RulesEngine } from '../domain/interfaces.js';
import type { ReviewSource, ReviewUnit, UnitReviewArea } from '../domain/types.js';

import { computeRulesDigest, loadBundledSystemCatalog, type SystemRuleCatalog } from './catalog.js';
import { buildUnitReviewArea } from './match.js';
import { loadProjectRuleText, parseProjectRules, type ProjectRules } from './project.js';

export interface RulesEngineOptions {
  /**
   * Repository root used to read `.opencodereview/rule.json` from the fixed
   * source. Hosts should pass the same root the repository was created with;
   * the default is the process working directory.
   */
  repoRoot?: string;
  /** Test seam; defaults to the catalog shipped in `assets/rules`. */
  systemRules?: SystemRuleCatalog;
  /** Test seam; defaults to reading the fixed source through git or the worktree. */
  readProjectRule?: (source: ReviewSource) => Promise<string | undefined>;
  gitPath?: string;
  gitTimeoutMs?: number;
  projectRuleMaxBytes?: number;
}

interface CachedProjectRules {
  key: string;
  rules: ProjectRules | undefined;
}

/**
 * Matches the private rule catalog to review units. System rules are bundled
 * with the package; project rules are read from the fixed review source, so a
 * review never picks up a rule file that is not part of its Git input. No
 * lookup touches the network.
 */
export class CatalogRulesEngine implements RulesEngine {
  readonly rulesDigest: string;

  private readonly catalog: SystemRuleCatalog;
  private readonly options: RulesEngineOptions;
  private readonly repoRoot: string;
  private cachedProjectRules: CachedProjectRules | undefined;

  constructor(options: RulesEngineOptions = {}) {
    this.options = { ...options };
    this.catalog = options.systemRules ?? loadBundledSystemCatalog();
    this.rulesDigest = computeRulesDigest(this.catalog);
    this.repoRoot = options.repoRoot ?? process.cwd();
  }

  async getAreas(source: ReviewSource, units: ReviewUnit[]): Promise<UnitReviewArea[]> {
    const project = await this.projectRules(source);
    return units.map((unit) =>
      buildUnitReviewArea({ unit, catalog: this.catalog, project, rulesDigest: this.rulesDigest }),
    );
  }

  private async projectRules(source: ReviewSource): Promise<ProjectRules | undefined> {
    const key = [
      source.repoId,
      source.mode,
      source.baseSha,
      source.headSha,
      source.workspaceFingerprint ?? '',
    ].join('\0');
    if (this.cachedProjectRules?.key === key) {
      return this.cachedProjectRules.rules;
    }

    const text = await loadProjectRuleText(source, {
      repoRoot: this.repoRoot,
      gitPath: this.options.gitPath,
      gitTimeoutMs: this.options.gitTimeoutMs,
      maxBytes: this.options.projectRuleMaxBytes,
      readProjectRule: this.options.readProjectRule,
    });
    const rules = text === undefined ? undefined : parseProjectRules(text);
    this.cachedProjectRules = { key, rules };
    return rules;
  }
}

export function createRulesEngine(options: RulesEngineOptions = {}): RulesEngine {
  return new CatalogRulesEngine(options);
}

/**
 * Compatibility alias for the scaffold export. New code should construct
 * CatalogRulesEngine or call createRulesEngine.
 */
export const PlaceholderRulesEngine = CatalogRulesEngine;
