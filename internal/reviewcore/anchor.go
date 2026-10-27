// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package reviewcore

import (
	"context"
	"fmt"
	"strings"
)

// LineSource provides immutable snapshot lines by path and side.
type LineSource interface {
	ReadLines(ctx context.Context, path, side string) ([]string, error)
}

// AnchorResult records deterministic relocation output.
type AnchorResult struct {
	Location Location
	Digest   string
	Located  bool
	Note     string
}

// ResolveAnchor validates a model-supplied location against snapshot contents.
// It never trusts line numbers: the snippet must match, and an ambiguous
// snippet is reported as unlocated instead of being guessed.
func ResolveAnchor(ctx context.Context, source LineSource, loc Location, defaultSide string) (AnchorResult, error) {
	loc.Path = normalizePath(loc.Path)
	if loc.Path == "" {
		return AnchorResult{}, Errorf(CodeInvalidArgument, "location.path is required")
	}
	if loc.Side == "" {
		loc.Side = defaultSide
	}
	if loc.Side != SideNew && loc.Side != SideOld {
		return AnchorResult{}, Errorf(CodeInvalidArgument, "location.side must be %q or %q", SideNew, SideOld)
	}
	lines, err := source.ReadLines(ctx, loc.Path, loc.Side)
	if err != nil {
		return AnchorResult{}, err
	}
	snippet := splitSnippet(loc.Snippet)
	if len(snippet) == 0 {
		return AnchorResult{Location: loc, Located: false, Note: "snippet is empty; location cannot be verified"}, nil
	}

	if loc.StartLine > 0 && loc.EndLine >= loc.StartLine {
		start := loc.StartLine - 1
		end := loc.EndLine
		if end <= len(lines) && start >= 0 && rangeMatches(lines[start:end], snippet) {
			loc.StartLine, loc.EndLine = start+1, end
			return AnchorResult{Location: loc, Digest: DigestLines(lines[start:end]), Located: true}, nil
		}
	}

	matches := findOccurrences(lines, snippet)
	switch len(matches) {
	case 0:
		return AnchorResult{Location: loc, Located: false, Note: "snippet not found on this side of the snapshot"}, nil
	case 1:
		start := matches[0]
		loc.StartLine = start + 1
		loc.EndLine = start + len(snippet)
		return AnchorResult{Location: loc, Digest: DigestLines(lines[start : start+len(snippet)]), Located: true}, nil
	default:
		return AnchorResult{
			Location: loc,
			Located:  false,
			Note:     fmt.Sprintf("snippet matches %d places (%s); add surrounding context", len(matches), formatLines(matches)),
		}, nil
	}
}

// ResolveEvidence validates evidence. Evidence may cite unchanged files, but it
// still must be inside the snapshot and not be a secret path.
func ResolveEvidence(ctx context.Context, source LineSource, evidence EvidenceRef, defaultSide string) (EvidenceRef, error) {
	evidence.Path = normalizePath(evidence.Path)
	if evidence.Path == "" {
		return EvidenceRef{}, Errorf(CodeInvalidArgument, "evidence.path is required")
	}
	if evidence.Side == "" {
		evidence.Side = defaultSide
	}
	if evidence.Side != SideNew && evidence.Side != SideOld {
		return EvidenceRef{}, Errorf(CodeInvalidArgument, "evidence.side must be %q or %q", SideNew, SideOld)
	}
	lines, err := source.ReadLines(ctx, evidence.Path, evidence.Side)
	if err != nil {
		return EvidenceRef{}, err
	}
	if evidence.Snippet != "" {
		result, err := ResolveAnchor(ctx, source, Location{
			Path: evidence.Path, Side: evidence.Side,
			StartLine: evidence.StartLine, EndLine: evidence.EndLine,
			Snippet: evidence.Snippet,
		}, defaultSide)
		if err != nil {
			return EvidenceRef{}, err
		}
		evidence.StartLine = result.Location.StartLine
		evidence.EndLine = result.Location.EndLine
		evidence.Digest = result.Digest
		evidence.Located = result.Located
		if result.Note != "" {
			evidence.Note = joinNote(evidence.Note, result.Note)
		}
		return evidence, nil
	}
	if evidence.StartLine < 1 || evidence.EndLine < evidence.StartLine || evidence.EndLine > len(lines) {
		return EvidenceRef{}, Errorf(CodeInvalidAnchor, "evidence %s:%d-%d is outside the file (%d lines)", evidence.Path, evidence.StartLine, evidence.EndLine, len(lines))
	}
	evidence.Digest = DigestLines(lines[evidence.StartLine-1 : evidence.EndLine])
	evidence.Located = true
	return evidence, nil
}

// DigestLines hashes normalized line content.
func DigestLines(lines []string) string {
	normalized := make([]string, len(lines))
	for i, line := range lines {
		normalized[i] = strings.TrimRight(line, " \t\r")
	}
	return HashString(strings.Join(normalized, "\n"))
}

func normalizePath(p string) string {
	p = strings.TrimSpace(strings.ReplaceAll(p, "\\", "/"))
	p = strings.TrimPrefix(p, "./")
	return p
}

func splitSnippet(snippet string) []string {
	raw := strings.Split(strings.ReplaceAll(snippet, "\r\n", "\n"), "\n")
	start, end := 0, len(raw)
	for start < end && strings.TrimSpace(raw[start]) == "" {
		start++
	}
	for end > start && strings.TrimSpace(raw[end-1]) == "" {
		end--
	}
	out := make([]string, 0, end-start)
	for _, line := range raw[start:end] {
		out = append(out, strings.TrimRight(line, " \t\r"))
	}
	return out
}

func rangeMatches(actual, snippet []string) bool {
	if len(actual) < len(snippet) {
		return false
	}
	for i := range snippet {
		if strings.TrimRight(actual[i], " \t\r") != snippet[i] {
			return false
		}
	}
	return true
}

func findOccurrences(lines, snippet []string) []int {
	var matches []int
	for i := 0; i+len(snippet) <= len(lines); i++ {
		if rangeMatches(lines[i:i+len(snippet)], snippet) {
			matches = append(matches, i)
			if len(matches) > 20 {
				break
			}
		}
	}
	return matches
}

func formatLines(matches []int) string {
	parts := make([]string, 0, len(matches))
	for _, match := range matches {
		parts = append(parts, fmt.Sprintf("line %d", match+1))
	}
	return strings.Join(parts, ", ")
}

func joinNote(a, b string) string {
	if a == "" {
		return b
	}
	if b == "" {
		return a
	}
	return a + "; " + b
}
