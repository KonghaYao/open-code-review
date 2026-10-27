// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package reviewrepo

import (
	"context"
	"strings"
	"testing"

	"github.com/KonghaYao/open-code-review/internal/reviewcore"
)

func ruleGroup(pack *reviewcore.RulePack, source, pattern string) *reviewcore.RuleGroup {
	for i := range pack.Groups {
		if pack.Groups[i].Source == source && pack.Groups[i].Pattern == pattern {
			return &pack.Groups[i]
		}
	}
	return nil
}

func TestRulesResolvesProjectAndSystem(t *testing.T) {
	tr := newTestRepo(t)
	tr.write("main.go", "package main\n")
	tr.write("docs/guide.md", "# guide\n")
	tr.write("README.md", "# readme\n")
	tr.write(projectRulePath, `{
  "rules": [
    {"path": "**/*.GO", "rule": "project go rule"},
    {"path": "docs/**", "rule": "docs rule", "merge_system_rule": true}
  ],
  "include": ["**/*.go"],
  "exclude": ["**/generated/**"]
}`)
	tr.commit("base")

	repo := tr.newRepo(Options{})
	snapshot := prepareInput(t, repo, reviewcore.InputSpec{Mode: reviewcore.ModeCommit, Commit: tr.head()})
	reader := mustOpen(t, repo, snapshot)

	pack, err := repo.Rules(context.Background(), reader, []string{"main.go", "docs/guide.md", "README.md", "main.go"})
	if err != nil {
		t.Fatalf("Rules: %v", err)
	}
	if len(pack.Groups) != 3 {
		t.Fatalf("expected three rule groups, got %+v", pack.Groups)
	}

	goGroup := ruleGroup(pack, projectSource, "**/*.GO")
	if goGroup == nil || goGroup.Text != "project go rule" {
		t.Fatalf("unexpected project group: %+v", goGroup)
	}
	if len(goGroup.Files) != 1 || goGroup.Files[0] != "main.go" {
		t.Fatalf("duplicate paths must collapse: %+v", goGroup.Files)
	}

	docsGroup := ruleGroup(pack, projectSource, "docs/**")
	if docsGroup == nil {
		t.Fatalf("missing docs group: %+v", pack.Groups)
	}
	if !strings.Contains(docsGroup.Text, "docs rule") || !strings.Contains(docsGroup.Text, "## System-Specific Rules (Mandatory)") {
		t.Fatalf("merge_system_rule was not applied: %q", docsGroup.Text)
	}
	if len(docsGroup.Files) != 1 || docsGroup.Files[0] != "docs/guide.md" {
		t.Fatalf("unexpected docs files: %+v", docsGroup.Files)
	}

	readmeGroup := ruleGroup(pack, systemSource, "default")
	if readmeGroup == nil || len(readmeGroup.Files) != 1 || readmeGroup.Files[0] != "README.md" {
		t.Fatalf("unexpected system group: %+v", pack.Groups)
	}

	if len(pack.Include) != 1 || pack.Include[0] != "**/*.go" {
		t.Fatalf("unexpected include patterns: %+v", pack.Include)
	}
	if len(pack.Exclude) != 1 || pack.Exclude[0] != "**/generated/**" {
		t.Fatalf("unexpected exclude patterns: %+v", pack.Exclude)
	}
	if pack.Digest == "" {
		t.Fatal("rule pack digest is empty")
	}

	again, err := repo.Rules(context.Background(), reader, []string{"main.go"})
	if err != nil {
		t.Fatalf("Rules(second): %v", err)
	}
	if again.Digest != pack.Digest {
		t.Fatalf("rule digest is not stable: %s != %s", again.Digest, pack.Digest)
	}
}

func TestRulesWithoutProjectFile(t *testing.T) {
	tr := newTestRepo(t)
	tr.write("main.go", "package main\n")
	tr.commit("base")

	repo := tr.newRepo(Options{})
	snapshot := prepareInput(t, repo, reviewcore.InputSpec{Mode: reviewcore.ModeCommit, Commit: tr.head()})
	reader := mustOpen(t, repo, snapshot)

	pack, err := repo.Rules(context.Background(), reader, []string{"main.go"})
	if err != nil {
		t.Fatalf("Rules: %v", err)
	}
	if len(pack.Include) != 0 || len(pack.Exclude) != 0 {
		t.Fatalf("missing project file must not invent filters: %+v", pack)
	}
	if len(pack.Groups) != 1 || pack.Groups[0].Source != systemSource {
		t.Fatalf("unexpected groups: %+v", pack.Groups)
	}
	if pack.Digest == "" {
		t.Fatal("rule pack digest is empty")
	}
}

func TestRulesReadsProjectFileFromSnapshot(t *testing.T) {
	tr := newTestRepo(t)
	tr.write("main.go", "package main\n")
	tr.write(projectRulePath, `{"rules":[{"path":"**/*.go","rule":"frozen rule"}]}`)
	tr.commit("base")

	repo := tr.newRepo(Options{})
	snapshot := prepareInput(t, repo, reviewcore.InputSpec{Mode: reviewcore.ModeWorkspace})

	tr.write(projectRulePath, `{"rules":[{"path":"**/*.go","rule":"live rule"}]}`)
	reader := mustOpen(t, repo, snapshot)
	pack, err := repo.Rules(context.Background(), reader, []string{"main.go"})
	if err != nil {
		t.Fatalf("Rules: %v", err)
	}
	if group := ruleGroup(pack, projectSource, "**/*.go"); group == nil || group.Text != "frozen rule" {
		t.Fatalf("rules must come from the frozen snapshot: %+v", pack.Groups)
	}
}

func TestRulesReadsUntrackedProjectFile(t *testing.T) {
	tr := newTestRepo(t)
	tr.write("main.go", "package main\n")
	tr.commit("base")
	tr.write(projectRulePath, `{"rules":[{"path":"**/*.go","rule":"untracked rule"}]}`)

	repo := tr.newRepo(Options{})
	snapshot := prepareInput(t, repo, reviewcore.InputSpec{Mode: reviewcore.ModeWorkspace})
	tr.write(projectRulePath, `{"rules":[{"path":"**/*.go","rule":"changed later"}]}`)

	reader := mustOpen(t, repo, snapshot)
	pack, err := repo.Rules(context.Background(), reader, []string{"main.go"})
	if err != nil {
		t.Fatalf("Rules: %v", err)
	}
	if group := ruleGroup(pack, projectSource, "**/*.go"); group == nil || group.Text != "untracked rule" {
		t.Fatalf("untracked rules must be frozen with the snapshot: %+v", pack.Groups)
	}
}

func TestRulesIgnoresDeletedProjectFile(t *testing.T) {
	tr := newTestRepo(t)
	tr.write("main.go", "package main\n")
	tr.write(projectRulePath, `{"rules":[{"path":"**/*.go","rule":"old rule"}]}`)
	base := tr.commit("base")
	tr.remove(projectRulePath)
	head := tr.commit("remove rules")

	repo := tr.newRepo(Options{})
	snapshot := prepareInput(t, repo, reviewcore.InputSpec{Mode: reviewcore.ModeRange, From: base, To: head})
	reader := mustOpen(t, repo, snapshot)
	pack, err := repo.Rules(context.Background(), reader, []string{"main.go"})
	if err != nil {
		t.Fatalf("Rules: %v", err)
	}
	if ruleGroup(pack, projectSource, "**/*.go") != nil {
		t.Fatalf("a deleted project rule file must not resolve: %+v", pack.Groups)
	}
	if len(pack.Include) != 0 || len(pack.Exclude) != 0 {
		t.Fatalf("a deleted project rule file must not supply filters: %+v", pack)
	}
}

func TestRulesSkipsDisabledProjectEntry(t *testing.T) {
	tr := newTestRepo(t)
	tr.write("main.go", "package main\n")
	tr.write(projectRulePath, `{"rules":[{"path":"**/*.go","rule":""},{"path":"**/*.go","rule":"second"}]}`)
	tr.commit("base")

	repo := tr.newRepo(Options{})
	snapshot := prepareInput(t, repo, reviewcore.InputSpec{Mode: reviewcore.ModeCommit, Commit: tr.head()})
	reader := mustOpen(t, repo, snapshot)
	pack, err := repo.Rules(context.Background(), reader, []string{"main.go"})
	if err != nil {
		t.Fatalf("Rules: %v", err)
	}
	if group := ruleGroup(pack, projectSource, "**/*.go"); group == nil || group.Text != "second" {
		t.Fatalf("a disabled entry must be skipped: %+v", pack.Groups)
	}

	tr.write(projectRulePath, `{"rules":[{"path":"**/*.go","rule":""}]}`)
	tr.commit("disable")
	snapshot = prepareInput(t, repo, reviewcore.InputSpec{Mode: reviewcore.ModeCommit, Commit: tr.head()})
	reader = mustOpen(t, repo, snapshot)
	pack, err = repo.Rules(context.Background(), reader, []string{"main.go"})
	if err != nil {
		t.Fatalf("Rules(disabled only): %v", err)
	}
	if ruleGroup(pack, projectSource, "**/*.go") != nil {
		t.Fatalf("the only entry is disabled, so the system rule must apply: %+v", pack.Groups)
	}
	if len(pack.Groups) != 1 || pack.Groups[0].Source != systemSource {
		t.Fatalf("unexpected groups: %+v", pack.Groups)
	}
}

func TestRulesRejectsInvalidProjectFile(t *testing.T) {
	tr := newTestRepo(t)
	tr.write("main.go", "package main\n")
	tr.write(projectRulePath, "{not json")
	tr.commit("base")

	repo := tr.newRepo(Options{})
	snapshot := prepareInput(t, repo, reviewcore.InputSpec{Mode: reviewcore.ModeCommit, Commit: tr.head()})
	reader := mustOpen(t, repo, snapshot)

	_, err := repo.Rules(context.Background(), reader, []string{"main.go"})
	requireCode(t, err, reviewcore.CodePreparationFailed)
}
