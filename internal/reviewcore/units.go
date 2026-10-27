// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package reviewcore

import (
	"path"
	"sort"
	"strconv"
	"strings"

	"github.com/bmatcuk/doublestar/v4"
)

// MaxChangedLinesPerUnit bounds each file unit. A single oversized hunk is
// sliced on raw diff-line boundaries.
const MaxChangedLinesPerUnit = 400

var defaultExcludedDirs = []string{
	".git", "node_modules", "vendor", "dist", "build", "target",
	".next", ".nuxt", "coverage", ".cache", "__pycache__", ".venv",
}

var testPatterns = []string{
	"**/*_test.go",
	"**/test_*.py", "**/*_test.py",
	"**/*.test.js", "**/*.test.jsx", "**/*.test.ts", "**/*.test.tsx",
	"**/*.spec.js", "**/*.spec.jsx", "**/*.spec.ts", "**/*.spec.tsx",
	"**/__tests__/**", "**/tests/**", "**/test/**",
	"**/*_spec.rb", "**/*Test.java", "**/*Tests.java", "**/*Test.kt",
	"**/src/test/**", "**/*Test.fs",
}

// IsTestPath applies the same test-file convention to every side.
func IsTestPath(p string) bool {
	p = strings.ReplaceAll(p, "\\", "/")
	for _, pattern := range testPatterns {
		ok, err := doublestar.Match(pattern, p)
		if err == nil && ok {
			return true
		}
	}
	return false
}

// IsProviderPath rejects dependency and build output directories.
func IsProviderPath(p string) bool {
	p = strings.ReplaceAll(p, "\\", "/")
	for _, dir := range defaultExcludedDirs {
		if p == dir || strings.HasPrefix(p, dir+"/") || strings.Contains(p, "/"+dir+"/") {
			return true
		}
	}
	return false
}

// PlanUnits converts changes into bounded file units plus one cross-file unit.
// The project filter comes from the same frozen snapshot as the changes.
func PlanUnits(changes []Change, scope Scope, pack *RulePack) ([]Unit, []ExcludedEntry) {
	var units []Unit
	var excluded []ExcludedEntry
	var includedPaths []string
	var changeIDs []string
	seenRefs := make(map[string]bool)

	for _, change := range changes {
		changePath := change.EffectivePath()
		side := SideNew
		if change.NewPath == "" {
			side = SideOld
		}
		reason := exclusionReason(change, changePath, scope, pack)
		if reason != "" {
			excluded = append(excluded, ExcludedEntry{Path: changePath, Side: side, Reason: reason, Source: change.Source})
			continue
		}
		includedPaths = append(includedPaths, changePath)
		changeIDs = append(changeIDs, change.ID)
		ruleRefs := refsForPath(pack, changePath)
		for _, ref := range ruleRefs {
			seenRefs[ref.Source+"\x00"+ref.Pattern] = true
		}

		if change.Binary {
			excluded = append(excluded, ExcludedEntry{Path: changePath, Side: side, Reason: ExcludeBinary, Source: change.Source})
			continue
		}

		if len(change.Hunks) == 0 {
			units = append(units, Unit{
				ID:        "u_" + shortHash(change.ID, "full"),
				Kind:      UnitFile,
				ChangeIDs: []string{change.ID},
				Paths:     []string{changePath},
				Side:      side,
				FullFile:  true,
				RuleRefs:  ruleRefs,
				Status:    UnitPending,
			})
			continue
		}

		for hunkIndex, hunk := range change.Hunks {
			for _, slice := range splitHunk(hunk, MaxChangedLinesPerUnit) {
				start, end := sliceLines(hunk, slice)
				units = append(units, Unit{
					ID:        "u_" + shortHash(change.ID, hunk.Header, strconv.Itoa(slice.Start), strconv.Itoa(slice.End)),
					Kind:      UnitFile,
					ChangeIDs: []string{change.ID},
					Paths:     []string{changePath},
					Side:      side,
					StartLine: start,
					EndLine:   end,
					Slices:    []HunkSlice{{HunkIndex: hunkIndex, Start: slice.Start, End: slice.End}},
					RuleRefs:  ruleRefs,
					Status:    UnitPending,
				})
			}
		}
	}

	if len(includedPaths) > 0 {
		refs := make([]RuleRef, 0, len(seenRefs))
		for key := range seenRefs {
			parts := strings.SplitN(key, "\x00", 2)
			refs = append(refs, RuleRef{Source: parts[0], Pattern: parts[1]})
		}
		sort.Slice(refs, func(i, j int) bool {
			if refs[i].Source != refs[j].Source {
				return refs[i].Source < refs[j].Source
			}
			return refs[i].Pattern < refs[j].Pattern
		})
		sort.Strings(includedPaths)
		sort.Strings(changeIDs)
		units = append(units, Unit{
			ID:        "u_cross_" + shortHash(includedPaths...),
			Kind:      UnitCrossFile,
			ChangeIDs: changeIDs,
			Paths:     includedPaths,
			RuleRefs:  refs,
			Status:    UnitPending,
		})
	}
	return units, excluded
}

func exclusionReason(change Change, changePath string, scope Scope, pack *RulePack) string {
	if changePath == "" {
		return ExcludeUnsupported
	}
	// Credentials are never reviewable, even when explicitly included.
	if isSecretPath(changePath) {
		return ExcludeSecret
	}
	userIncluded := matchesAny(scope.Include, changePath)
	if !userIncluded {
		if matchesAny(scope.Exclude, changePath) {
			return ExcludeUserExclude
		}
		if IsProviderPath(changePath) {
			return ExcludeProvider
		}
	}
	if pack != nil {
		if !userIncluded && len(pack.Include) > 0 && !matchesAny(pack.Include, changePath) {
			return ExcludeDefaultPath
		}
		if !userIncluded && matchesAny(pack.Exclude, changePath) {
			return ExcludeUserExclude
		}
	}
	if !scope.IncludeTests && IsTestPath(changePath) {
		return ExcludeTests
	}
	if change.NewPath == "" && !scope.IncludeDeleted {
		return ExcludeDeleted
	}
	if change.Binary {
		return ExcludeBinary
	}
	return ""
}

func matchesAny(patterns []string, p string) bool {
	p = strings.ReplaceAll(p, "\\", "/")
	for _, pattern := range patterns {
		if ok, err := doublestar.Match(pattern, p); err == nil && ok {
			return true
		}
	}
	return false
}

func refsForPath(pack *RulePack, p string) []RuleRef {
	if pack == nil {
		return nil
	}
	var refs []RuleRef
	for _, group := range pack.Groups {
		for _, file := range group.Files {
			if file == p {
				refs = append(refs, RuleRef{Source: group.Source, Pattern: group.Pattern})
				break
			}
		}
	}
	return refs
}

type lineSlice struct{ Start, End int }

// splitHunk slices raw hunk lines into chunks of at most max changed lines.
func splitHunk(hunk Hunk, max int) []lineSlice {
	var slices []lineSlice
	start, changed := 0, 0
	for i, line := range hunk.Lines {
		if changed >= max {
			slices = append(slices, lineSlice{Start: start, End: i})
			start, changed = i, 0
		}
		if len(line) > 0 && (line[0] == '+' || line[0] == '-') {
			changed++
		}
	}
	if start < len(hunk.Lines) {
		slices = append(slices, lineSlice{Start: start, End: len(hunk.Lines)})
	}
	if len(slices) == 0 {
		slices = append(slices, lineSlice{Start: 0, End: len(hunk.Lines)})
	}
	return slices
}

func sliceLines(hunk Hunk, slice lineSlice) (int, int) {
	newLine := hunk.NewStart
	start, end := newLine, newLine
	for i := 0; i < slice.End && i < len(hunk.Lines); i++ {
		line := hunk.Lines[i]
		if i == slice.Start {
			start = newLine
		}
		if len(line) > 0 && line[0] != '-' {
			end = newLine
			newLine++
		}
	}
	if end < start {
		end = start
	}
	return start, end
}

// IsSecretPath is the hard credential exclusion applied to diffs, reads and
// searches. It cannot be overridden by include patterns.
func IsSecretPath(p string) bool { return isSecretPath(p) }

func isSecretPath(p string) bool {
	base := path.Base(strings.ReplaceAll(p, "\\", "/"))
	lower := strings.ToLower(base)
	secretNames := []string{
		".env", ".env.local", ".env.production", ".env.development",
		"id_rsa", "id_ed25519", "credentials", "credentials.json",
		"secrets.yml", "secrets.yaml", "secret.yaml",
	}
	for _, name := range secretNames {
		if lower == name || strings.HasPrefix(lower, name+".") {
			return true
		}
	}
	secretSuffixes := []string{".pem", ".key", ".p12", ".pfx", ".keystore"}
	for _, suffix := range secretSuffixes {
		if strings.HasSuffix(lower, suffix) {
			return true
		}
	}
	return false
}
