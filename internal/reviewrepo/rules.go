// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package reviewrepo

import (
	"context"
	"encoding/json"
	"sort"
	"strings"

	"github.com/bmatcuk/doublestar/v4"

	"github.com/KonghaYao/open-code-review/internal/config/rules"
	"github.com/KonghaYao/open-code-review/internal/reviewcore"
)

const (
	projectRulePath = ".opencodereview/rule.json"
	systemSource    = "system"
	projectSource   = "project"
)

type resolvedRule struct {
	source  string
	pattern string
	text    string
}

// Rules resolves system and project rules against the same frozen snapshot the
// reader serves. The project rule file is read through the reader, never from
// the worktree, so a review cannot pick up rules that were not part of it.
func (r *Repo) Rules(ctx context.Context, reader reviewcore.Reader, paths []string) (*reviewcore.RulePack, error) {
	system, err := rules.LoadDefault()
	if err != nil {
		return nil, reviewcore.Errorf(reviewcore.CodePreparationFailed, "load system rules: %v", err)
	}
	project, rawProject, err := loadProjectRules(ctx, reader)
	if err != nil {
		return nil, err
	}

	pack := &reviewcore.RulePack{}
	if project != nil {
		pack.Include = cleanRulePatterns(project.Include)
		pack.Exclude = cleanRulePatterns(project.Exclude)
	}

	groups := make(map[string]*reviewcore.RuleGroup)
	for _, path := range uniquePaths(paths) {
		for _, resolved := range resolvePathRules(system, project, path) {
			key := resolved.source + "\x00" + resolved.pattern + "\x00" + resolved.text
			group, ok := groups[key]
			if !ok {
				group = &reviewcore.RuleGroup{
					Source:  resolved.source,
					Pattern: resolved.pattern,
					Text:    resolved.text,
				}
				groups[key] = group
			}
			group.Files = append(group.Files, path)
		}
	}
	for _, group := range groups {
		sort.Strings(group.Files)
		pack.Groups = append(pack.Groups, *group)
	}
	sort.Slice(pack.Groups, func(i, j int) bool {
		if pack.Groups[i].Source != pack.Groups[j].Source {
			return pack.Groups[i].Source < pack.Groups[j].Source
		}
		if pack.Groups[i].Pattern != pack.Groups[j].Pattern {
			return pack.Groups[i].Pattern < pack.Groups[j].Pattern
		}
		return pack.Groups[i].Text < pack.Groups[j].Text
	})

	pack.Digest, err = reviewcore.CanonicalHash(struct {
		System  []string `json:"system"`
		Project string   `json:"project,omitempty"`
		Include []string `json:"include,omitempty"`
		Exclude []string `json:"exclude,omitempty"`
	}{
		System:  system.CanonicalConfig(),
		Project: string(rawProject),
		Include: pack.Include,
		Exclude: pack.Exclude,
	})
	if err != nil {
		return nil, err
	}
	return pack, nil
}

// loadProjectRules returns nil when the snapshot has no project rule file,
// which is a normal configuration rather than an error.
func loadProjectRules(ctx context.Context, reader reviewcore.Reader) (*rules.ProjectRule, []byte, error) {
	content, err := reader.ReadFile(ctx, projectRulePath, reviewcore.SideNew)
	if err != nil {
		if reviewcore.IsCode(err, reviewcore.CodePathOutOfScope) {
			return nil, nil, nil
		}
		return nil, nil, err
	}
	if content.Binary {
		return nil, nil, reviewcore.Errorf(reviewcore.CodePreparationFailed, "%s is binary", projectRulePath)
	}
	if content.TooLarge {
		return nil, nil, reviewcore.Errorf(reviewcore.CodePreparationFailed, "%s is too large", projectRulePath)
	}
	raw := []byte(content.Content)
	if len(strings.TrimSpace(content.Content)) == 0 {
		return nil, raw, nil
	}
	var project rules.ProjectRule
	if err := json.Unmarshal(raw, &project); err != nil {
		return nil, nil, reviewcore.Errorf(reviewcore.CodePreparationFailed, "parse %s: %v", projectRulePath, err)
	}
	return &project, raw, nil
}

func resolvePathRules(system *rules.SystemRule, project *rules.ProjectRule, path string) []resolvedRule {
	systemPattern, systemText := matchSystemRule(system, path)
	if entry := matchProjectEntry(project, path); entry != nil {
		if entry.MergeSystemRule {
			return []resolvedRule{{source: projectSource, pattern: entry.Path, text: mergeSystemRule(systemText, entry.Rule)}}
		}
		return []resolvedRule{{source: projectSource, pattern: entry.Path, text: entry.Rule}}
	}
	return []resolvedRule{{source: systemSource, pattern: systemPattern, text: systemText}}
}

// matchSystemRule mirrors the upstream first-match-wins resolver, which keeps
// the declaration pattern intact and reports "default" for the fallback.
func matchSystemRule(system *rules.SystemRule, path string) (string, string) {
	lowerPath := strings.ToLower(path)
	for _, rule := range system.PathRules {
		for _, pattern := range expandBraces(rule.Pattern) {
			if matched, err := doublestar.Match(strings.ToLower(pattern), lowerPath); err == nil && matched {
				return rule.Pattern, rule.Rule
			}
		}
	}
	return "default", system.DefaultRule
}

// matchProjectEntry mirrors the upstream resolver: declaration order wins and
// matching is case-insensitive with brace expansion.
func matchProjectEntry(project *rules.ProjectRule, path string) *rules.ProjectRuleEntry {
	if project == nil {
		return nil
	}
	lowerPath := strings.ToLower(path)
	for i := range project.Rules {
		entry := &project.Rules[i]
		// An entry without text and without a merge request is disabled, the
		// same way the upstream resolver treats it.
		if entry.Rule == "" && !entry.MergeSystemRule {
			continue
		}
		for _, pattern := range expandBraces(entry.Path) {
			if matched, err := doublestar.Match(strings.ToLower(pattern), lowerPath); err == nil && matched {
				return entry
			}
		}
	}
	return nil
}

func expandBraces(value string) []string {
	open := strings.IndexByte(value, '{')
	if open < 0 {
		return []string{value}
	}
	close := strings.IndexByte(value[open:], '}')
	if close < 0 {
		return []string{value}
	}
	close += open
	prefix := value[:open]
	suffix := value[close+1:]
	var expanded []string
	for _, option := range strings.Split(value[open+1:close], ",") {
		expanded = append(expanded, prefix+option+suffix)
	}
	return expanded
}

func mergeSystemRule(systemRule, projectRule string) string {
	if systemRule == "" {
		return projectRule
	}
	if projectRule == "" {
		return systemRule
	}
	return "## System-Specific Rules (Mandatory)\n\n" + systemRule +
		"\n\n---\n\n## User-Specific Rules (Mandatory)\n\n" + projectRule
}

func cleanRulePatterns(patterns []string) []string {
	cleaned := make([]string, 0, len(patterns))
	for _, pattern := range patterns {
		pattern = strings.TrimSpace(pattern)
		if pattern != "" {
			cleaned = append(cleaned, pattern)
		}
	}
	return cleaned
}

func uniquePaths(paths []string) []string {
	seen := make(map[string]bool, len(paths))
	unique := make([]string, 0, len(paths))
	for _, path := range paths {
		path = normalizeRepoPath(path)
		if path == "" || seen[path] {
			continue
		}
		seen[path] = true
		unique = append(unique, path)
	}
	sort.Strings(unique)
	return unique
}
