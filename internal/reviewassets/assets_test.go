// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package reviewassets

import (
	"reflect"
	"strings"
	"testing"
)

const (
	skillURI          = "skill://project/review/SKILL.md"
	codeReviewerURI   = "agent://project/code-reviewer/agent.md"
	reviewVerifierURI = "agent://project/review-verifier/agent.md"
)

func TestNewPublishesSkillAndAgents(t *testing.T) {
	source, err := New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	skill := source.Skill()
	if skill.URI != skillURI {
		t.Fatalf("skill URI = %q, want %q", skill.URI, skillURI)
	}
	if skill.Name != "review" {
		t.Fatalf("skill name = %q, want review", skill.Name)
	}
	if skill.Frontmatter["name"] != skill.Name {
		t.Fatalf("frontmatter name = %v, want %q", skill.Frontmatter["name"], skill.Name)
	}
	if strings.TrimSpace(skill.Description) == "" {
		t.Fatal("skill description is empty")
	}
	if skill.MIMEType != "text/markdown" {
		t.Fatalf("skill MIME type = %q", skill.MIMEType)
	}
	if len(skill.Resources) != 1 {
		t.Fatalf("skill resources = %+v, want exactly SKILL.md", skill.Resources)
	}
	if skill.Resources[0].URI != skill.URI {
		t.Fatalf("resource URI = %q, want %q", skill.Resources[0].URI, skill.URI)
	}
	if skill.Resources[0].Digest != skill.Digest {
		t.Fatalf("resource digest = %q, want %q", skill.Resources[0].Digest, skill.Digest)
	}
	if !strings.HasPrefix(skill.Digest, "sha256:") {
		t.Fatalf("skill digest = %q, want sha256 prefix", skill.Digest)
	}
	if !strings.Contains(skill.Content, "# Peri code review") {
		t.Fatal("skill content does not contain its title")
	}

	agents := source.Agents()
	if len(agents) != 2 {
		t.Fatalf("agents = %+v, want two definitions", agents)
	}
	// Agents are sorted by name so discovery is deterministic.
	wantAgents := []struct {
		name string
		uri  string
	}{
		{name: "code-reviewer", uri: codeReviewerURI},
		{name: "review-verifier", uri: reviewVerifierURI},
	}
	for i, want := range wantAgents {
		agent := agents[i]
		if agent.Name != want.name || agent.URI != want.uri {
			t.Fatalf("agent[%d] = (%q, %q), want (%q, %q)", i, agent.Name, agent.URI, want.name, want.uri)
		}
		if agent.Frontmatter["name"] != agent.Name {
			t.Fatalf("agent %q frontmatter name = %v", agent.Name, agent.Frontmatter["name"])
		}
		if strings.TrimSpace(agent.Description) == "" {
			t.Fatalf("agent %q description is empty", agent.Name)
		}
		if agent.MIMEType != "text/markdown" {
			t.Fatalf("agent %q MIME type = %q", agent.Name, agent.MIMEType)
		}
		if !strings.HasPrefix(agent.Digest, "sha256:") {
			t.Fatalf("agent %q digest = %q", agent.Name, agent.Digest)
		}
	}

	if !strings.HasPrefix(source.Digest(), "sha256:") {
		t.Fatalf("asset digest = %q, want sha256 prefix", source.Digest())
	}
}

func TestDigestIsStableAcrossInstances(t *testing.T) {
	first, err := New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	second, err := New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if first.Digest() != second.Digest() {
		t.Fatalf("asset digest changed between instances: %q != %q", first.Digest(), second.Digest())
	}
	if first.Skill().Digest != second.Skill().Digest {
		t.Fatalf("skill digest changed between instances: %q != %q", first.Skill().Digest, second.Skill().Digest)
	}
	agents := first.Agents()
	if len(agents) != 2 {
		t.Fatalf("agents = %d, want 2", len(agents))
	}
	// Agents returns a defensive copy; mutating it must not leak into the source.
	agents[0].Name = "mutated"
	if first.Agents()[0].Name != "code-reviewer" {
		t.Fatal("Agents returned the internal slice")
	}
}

func TestSplitFrontmatterParsesScalars(t *testing.T) {
	content := "---\n" +
		"name: review\n" +
		"description: \"A \\\"quoted\\\" description\"\n" +
		"owner: 'it''s me'\n" +
		"userInvocable: true\n" +
		"disabled: false\n" +
		"empty:\n" +
		"tags: [alpha, 'beta', \"gamma\"]\n" +
		"none: []\n" +
		"# a comment\n" +
		"---\n" +
		"body line\n"

	fields, body, err := SplitFrontmatter(content)
	if err != nil {
		t.Fatalf("SplitFrontmatter: %v", err)
	}
	if body != "body line\n" {
		t.Fatalf("body = %q", body)
	}
	if fields["name"] != "review" {
		t.Fatalf("name = %v", fields["name"])
	}
	if fields["description"] != `A "quoted" description` {
		t.Fatalf("description = %q", fields["description"])
	}
	if fields["owner"] != "it's me" {
		t.Fatalf("owner = %q", fields["owner"])
	}
	if fields["userInvocable"] != true || fields["disabled"] != false {
		t.Fatalf("booleans = %v / %v", fields["userInvocable"], fields["disabled"])
	}
	if fields["empty"] != "" {
		t.Fatalf("empty = %v", fields["empty"])
	}
	if got := fields["tags"]; !reflect.DeepEqual(got, []string{"alpha", "beta", "gamma"}) {
		t.Fatalf("tags = %#v", got)
	}
	if got := fields["none"]; !reflect.DeepEqual(got, []string{}) {
		t.Fatalf("none = %#v, want empty list", got)
	}
}

func TestSplitFrontmatterAcceptsCRLF(t *testing.T) {
	content := "---\r\nname: review\r\n---\r\nbody\r\n"
	fields, body, err := SplitFrontmatter(content)
	if err != nil {
		t.Fatalf("SplitFrontmatter: %v", err)
	}
	// SplitFrontmatter normalizes CRLF before slicing, so the body is LF-only.
	if fields["name"] != "review" || body != "body\n" {
		t.Fatalf("fields = %v, body = %q", fields, body)
	}
}

func TestSplitFrontmatterRejectsMalformedDocuments(t *testing.T) {
	tests := []struct {
		name    string
		content string
		want    string
	}{
		{name: "missing opening marker", content: "name: review\n---\nbody", want: "must start"},
		{name: "leading blank line", content: "\n---\nname: review\n---\n", want: "must start"},
		{name: "unclosed frontmatter", content: "---\nname: review\n", want: "not closed"},
		{name: "line without colon", content: "---\nname review\n---\n", want: "not a key/value pair"},
		{name: "empty key", content: "---\n: review\n---\n", want: "empty key"},
		{name: "unterminated double quote", content: "---\nname: \"review\n---\n", want: "unterminated quoted string"},
		{name: "unterminated single quote", content: "---\nname: 'review\n---\n", want: "unterminated quoted string"},
		{name: "unterminated inline list", content: "---\ntags: [a, b\n---\n", want: "unterminated inline list"},
		{name: "block scalar", content: "---\nbody: |\n---\n", want: "block scalars are not supported"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, _, err := SplitFrontmatter(test.content)
			if err == nil {
				t.Fatal("expected an error")
			}
			if !strings.Contains(err.Error(), test.want) {
				t.Fatalf("error = %v, want %q", err, test.want)
			}
		})
	}
}

func TestParseDocumentRequiresNameAndDescription(t *testing.T) {
	if _, err := ParseDocument("---\ndescription: only\n---\n"); err == nil {
		t.Fatal("missing name must fail")
	}
	if _, err := ParseDocument("---\nname: only\n---\n"); err == nil {
		t.Fatal("missing description must fail")
	}
	doc, err := ParseDocument("---\nname: review\ndescription: text\n---\nbody\n")
	if err != nil {
		t.Fatalf("ParseDocument: %v", err)
	}
	if doc.Name != "review" || doc.Description != "text" || !strings.HasPrefix(doc.Digest, "sha256:") {
		t.Fatalf("unexpected document: %+v", doc)
	}
}
