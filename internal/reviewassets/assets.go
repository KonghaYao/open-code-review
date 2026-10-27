// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

// Package reviewassets publishes the Skill and Agent definitions Peri loads
// from this MCP server. The files are embedded so the server is self-contained.
package reviewassets

import (
	_ "embed"
	"fmt"
	"sort"
	"strings"

	"github.com/KonghaYao/open-code-review/internal/reviewcore"
)

//go:embed assets/skill/SKILL.md
var skillFile string

//go:embed assets/agents/code-reviewer.md
var codeReviewerFile string

//go:embed assets/agents/review-verifier.md
var reviewVerifierFile string

// Source implements reviewcore.AssetSource.
type Source struct {
	skill  reviewcore.AssetDoc
	agents []reviewcore.AssetDoc
	digest string
}

var _ reviewcore.AssetSource = (*Source)(nil)

// New parses and validates the embedded assets.
func New() (*Source, error) {
	skill, err := ParseDocument(skillFile)
	if err != nil {
		return nil, fmt.Errorf("parse skill: %w", err)
	}
	skill.URI = "skill://project/" + skill.Name + "/SKILL.md"
	skill.MIMEType = "text/markdown"
	skill.Resources = []reviewcore.AssetResource{{URI: skill.URI, Digest: skill.Digest}}

	source := &Source{skill: skill}
	for _, raw := range []string{codeReviewerFile, reviewVerifierFile} {
		agent, parseErr := ParseDocument(raw)
		if parseErr != nil {
			return nil, fmt.Errorf("parse agent: %w", parseErr)
		}
		agent.URI = "agent://project/" + agent.Name + "/agent.md"
		agent.MIMEType = "text/markdown"
		source.agents = append(source.agents, agent)
	}
	sort.Slice(source.agents, func(i, j int) bool { return source.agents[i].Name < source.agents[j].Name })
	digest, err := assetDigest(skill, source.agents)
	if err != nil {
		return nil, err
	}
	source.digest = digest
	return source, nil
}

// Skill returns the single published skill.
func (s *Source) Skill() reviewcore.AssetDoc { return s.skill }

// Agents returns the published agent definitions.
func (s *Source) Agents() []reviewcore.AssetDoc {
	return append([]reviewcore.AssetDoc(nil), s.agents...)
}

// Digest identifies the complete asset set; resume refuses to mix assets.
func (s *Source) Digest() string { return s.digest }

// ParseDocument parses YAML frontmatter with the deliberately small scalar
// subset used by the embedded definitions. Unknown constructs fail loudly so a
// mismatch with Peri's parser is caught here, not at activation time.
func ParseDocument(content string) (reviewcore.AssetDoc, error) {
	frontmatter, _, err := SplitFrontmatter(content)
	if err != nil {
		return reviewcore.AssetDoc{}, err
	}
	name, _ := frontmatter["name"].(string)
	if strings.TrimSpace(name) == "" {
		return reviewcore.AssetDoc{}, fmt.Errorf("frontmatter name is required")
	}
	description, _ := frontmatter["description"].(string)
	if strings.TrimSpace(description) == "" {
		return reviewcore.AssetDoc{}, fmt.Errorf("frontmatter description is required")
	}
	return reviewcore.AssetDoc{
		Name:        strings.TrimSpace(name),
		Description: strings.TrimSpace(description),
		Content:     content,
		Digest:      reviewcore.HashBytes([]byte(content)),
		Frontmatter: frontmatter,
	}, nil
}

// SplitFrontmatter returns the parsed frontmatter and the body after it.
func SplitFrontmatter(content string) (map[string]any, string, error) {
	normalized := strings.ReplaceAll(content, "\r\n", "\n")
	if !strings.HasPrefix(normalized, "---\n") {
		return nil, "", fmt.Errorf("document must start with YAML frontmatter")
	}
	rest := normalized[len("---\n"):]
	index := strings.Index(rest, "\n---\n")
	if index < 0 {
		return nil, "", fmt.Errorf("frontmatter is not closed")
	}
	raw := rest[:index]
	body := rest[index+len("\n---\n"):]
	fields, err := parseScalars(raw)
	if err != nil {
		return nil, "", err
	}
	return fields, body, nil
}

func parseScalars(raw string) (map[string]any, error) {
	fields := make(map[string]any)
	for lineNumber, line := range strings.Split(raw, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, ":")
		if !ok {
			return nil, fmt.Errorf("frontmatter line %d is not a key/value pair", lineNumber+1)
		}
		key = strings.TrimSpace(key)
		if key == "" {
			return nil, fmt.Errorf("frontmatter line %d has an empty key", lineNumber+1)
		}
		parsed, err := parseScalar(strings.TrimSpace(value))
		if err != nil {
			return nil, fmt.Errorf("frontmatter %q: %w", key, err)
		}
		fields[key] = parsed
	}
	return fields, nil
}

func parseScalar(value string) (any, error) {
	switch {
	case value == "":
		return "", nil
	case value == "true":
		return true, nil
	case value == "false":
		return false, nil
	case strings.HasPrefix(value, "\"") || strings.HasPrefix(value, "'"):
		return unquote(value)
	case strings.HasPrefix(value, "["):
		return parseInlineList(value)
	case value == "|" || value == ">":
		return nil, fmt.Errorf("block scalars are not supported")
	default:
		return value, nil
	}
}

func unquote(value string) (string, error) {
	if len(value) < 2 || value[0] != value[len(value)-1] {
		return "", fmt.Errorf("unterminated quoted string")
	}
	quote := value[0]
	inner := value[1 : len(value)-1]
	if quote == '\'' {
		return strings.ReplaceAll(inner, "''", "'"), nil
	}
	replacer := strings.NewReplacer(`\"`, `"`, `\\`, `\`, `\n`, "\n", `\t`, "\t")
	return replacer.Replace(inner), nil
}

func parseInlineList(value string) ([]string, error) {
	if !strings.HasSuffix(value, "]") {
		return nil, fmt.Errorf("unterminated inline list")
	}
	inner := strings.TrimSpace(value[1 : len(value)-1])
	if inner == "" {
		return []string{}, nil
	}
	parts := strings.Split(inner, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		item, err := parseScalar(strings.TrimSpace(part))
		if err != nil {
			return nil, err
		}
		out = append(out, fmt.Sprint(item))
	}
	return out, nil
}

func assetDigest(skill reviewcore.AssetDoc, agents []reviewcore.AssetDoc) (string, error) {
	type entry struct {
		URI    string `json:"uri"`
		Digest string `json:"digest"`
	}
	entries := []entry{{URI: skill.URI, Digest: skill.Digest}}
	for _, agent := range agents {
		entries = append(entries, entry{URI: agent.URI, Digest: agent.Digest})
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].URI < entries[j].URI })
	return reviewcore.CanonicalHash(entries)
}
