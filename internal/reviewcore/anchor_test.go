// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package reviewcore

import (
	"context"
	"errors"
	"strings"
	"testing"
)

type fakeLineSource struct {
	lines map[string][]string
	err   error
}

func (f fakeLineSource) ReadLines(_ context.Context, path, side string) ([]string, error) {
	if f.err != nil {
		return nil, f.err
	}
	lines, ok := f.lines[side+"\x00"+path]
	if !ok {
		return nil, Errorf(CodePathOutOfScope, "%s:%s is not in the snapshot", path, side)
	}
	return lines, nil
}

func newFakeLineSource() fakeLineSource {
	lines := []string{"package a", "", "func Foo() {", "\treturn", "}", "", "// dup", "dup", "dup"}
	return fakeLineSource{
		lines: map[string][]string{
			SideNew + "\x00a.go": lines,
			SideOld + "\x00a.go": {"old", "dup"},
		},
	}
}

func TestResolveAnchorUniqueSnippet(t *testing.T) {
	source := newFakeLineSource()
	result, err := ResolveAnchor(context.Background(), source, Location{
		Path: "a.go", Snippet: "func Foo() {",
	}, SideNew)
	if err != nil {
		t.Fatalf("ResolveAnchor: %v", err)
	}
	if !result.Located {
		t.Fatalf("result = %+v, want located", result)
	}
	if result.Location.StartLine != 3 || result.Location.EndLine != 3 {
		t.Fatalf("lines = %d-%d, want 3-3", result.Location.StartLine, result.Location.EndLine)
	}
	if result.Location.Side != SideNew {
		t.Fatalf("side = %q, want %q", result.Location.Side, SideNew)
	}
	if want := DigestLines(source.lines[SideNew+"\x00a.go"][2:3]); result.Digest != want {
		t.Fatalf("digest = %q, want %q", result.Digest, want)
	}
}

func TestResolveAnchorUsesMatchingLineRangeWhenSnippetRepeats(t *testing.T) {
	source := newFakeLineSource()
	result, err := ResolveAnchor(context.Background(), source, Location{
		Path: "a.go", StartLine: 8, EndLine: 8, Snippet: "dup",
	}, SideNew)
	if err != nil {
		t.Fatalf("ResolveAnchor: %v", err)
	}
	if !result.Located || result.Location.StartLine != 8 || result.Location.EndLine != 8 {
		t.Fatalf("result = %+v, want 8-8", result)
	}
	if !strings.HasPrefix(result.Digest, "sha256:") {
		t.Fatalf("digest = %q", result.Digest)
	}
}

func TestResolveAnchorReportsAmbiguousSnippet(t *testing.T) {
	source := newFakeLineSource()
	result, err := ResolveAnchor(context.Background(), source, Location{Path: "a.go", Snippet: "dup"}, SideNew)
	if err != nil {
		t.Fatalf("ResolveAnchor: %v", err)
	}
	if result.Located {
		t.Fatalf("result = %+v, want unlocated", result)
	}
	if !strings.Contains(result.Note, "matches 2 places") {
		t.Fatalf("note = %q, want the match count", result.Note)
	}
}

// ResolveAnchor reports an absent snippet as an unlocated result; the caller
// decides whether that is fatal. This locks the current contract.
func TestResolveAnchorMissingSnippetIsUnlocated(t *testing.T) {
	source := newFakeLineSource()
	result, err := ResolveAnchor(context.Background(), source, Location{Path: "a.go", Snippet: "not here"}, SideNew)
	if err != nil {
		t.Fatalf("ResolveAnchor: %v", err)
	}
	if result.Located || !strings.Contains(result.Note, "not found") {
		t.Fatalf("result = %+v, want an unlocated result with a note", result)
	}
}

// Line hints that fall outside the file are ignored; the snippet is still the
// authority and is relocated to its real position.
func TestResolveAnchorIgnoresOutOfRangeLineHints(t *testing.T) {
	source := newFakeLineSource()
	result, err := ResolveAnchor(context.Background(), source, Location{
		Path: "a.go", StartLine: 99, EndLine: 120, Snippet: "func Foo() {",
	}, SideNew)
	if err != nil {
		t.Fatalf("ResolveAnchor: %v", err)
	}
	if !result.Located || result.Location.StartLine != 3 || result.Location.EndLine != 3 {
		t.Fatalf("result = %+v, want relocation to 3-3", result)
	}
}

// Out-of-range hints are not errors on their own: without a matching snippet
// the result is simply unlocated. ResolveEvidence is where a location without a
// verifiable snippet becomes INVALID_ANCHOR.
func TestResolveAnchorOutOfRangeHintWithoutSnippetIsUnlocated(t *testing.T) {
	source := newFakeLineSource()
	result, err := ResolveAnchor(context.Background(), source, Location{
		Path: "a.go", StartLine: 99, EndLine: 100, Snippet: "absent",
	}, SideNew)
	if err != nil {
		t.Fatalf("ResolveAnchor: %v", err)
	}
	if result.Located || !strings.Contains(result.Note, "not found") {
		t.Fatalf("result = %+v, want an unlocated result", result)
	}
}

func TestResolveAnchorEmptySnippetIsUnlocated(t *testing.T) {
	source := newFakeLineSource()
	result, err := ResolveAnchor(context.Background(), source, Location{Path: "a.go", Snippet: " \n\t"}, SideNew)
	if err != nil {
		t.Fatalf("ResolveAnchor: %v", err)
	}
	if result.Located || !strings.Contains(result.Note, "snippet is empty") {
		t.Fatalf("result = %+v", result)
	}
}

func TestResolveAnchorUsesDefaultSide(t *testing.T) {
	source := newFakeLineSource()
	result, err := ResolveAnchor(context.Background(), source, Location{Path: "a.go", Snippet: "dup"}, SideOld)
	if err != nil {
		t.Fatalf("ResolveAnchor: %v", err)
	}
	if !result.Located || result.Location.Side != SideOld || result.Location.StartLine != 2 {
		t.Fatalf("result = %+v, want the old side at line 2", result)
	}
}

func TestResolveAnchorValidatesPathAndSide(t *testing.T) {
	source := newFakeLineSource()

	_, err := ResolveAnchor(context.Background(), source, Location{Snippet: "x"}, SideNew)
	if !IsCode(err, CodeInvalidArgument) {
		t.Fatalf("empty path error = %v, want %s", err, CodeInvalidArgument)
	}

	_, err = ResolveAnchor(context.Background(), source, Location{Path: "a.go", Side: "both", Snippet: "x"}, SideNew)
	if !IsCode(err, CodeInvalidArgument) {
		t.Fatalf("invalid side error = %v, want %s", err, CodeInvalidArgument)
	}
}

func TestResolveAnchorPropagatesSourceErrors(t *testing.T) {
	boom := errors.New("read failed")
	_, err := ResolveAnchor(context.Background(), fakeLineSource{err: boom}, Location{Path: "a.go", Snippet: "x"}, SideNew)
	if !errors.Is(err, boom) {
		t.Fatalf("error = %v, want %v", err, boom)
	}
}

func TestResolveEvidenceRejectsOutOfRangeLines(t *testing.T) {
	source := newFakeLineSource()
	_, err := ResolveEvidence(context.Background(), source, EvidenceRef{
		Path: "a.go", StartLine: 10, EndLine: 12,
	}, SideNew)
	if !IsCode(err, CodeInvalidAnchor) {
		t.Fatalf("error = %v, want %s", err, CodeInvalidAnchor)
	}
}

func TestResolveEvidenceRelocatesBySnippet(t *testing.T) {
	source := newFakeLineSource()
	evidence, err := ResolveEvidence(context.Background(), source, EvidenceRef{
		Path: "a.go", StartLine: 99, EndLine: 120, Snippet: "func Foo() {",
	}, SideNew)
	if err != nil {
		t.Fatalf("ResolveEvidence: %v", err)
	}
	if !evidence.Located || evidence.StartLine != 3 || evidence.EndLine != 3 {
		t.Fatalf("evidence = %+v, want relocation to 3-3", evidence)
	}
	if !strings.HasPrefix(evidence.Digest, "sha256:") {
		t.Fatalf("digest = %q", evidence.Digest)
	}
}
