// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package reviewrepo

import (
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/KonghaYao/open-code-review/internal/reviewcore"
)

func TestSplitContentLines(t *testing.T) {
	cases := []struct {
		name     string
		input    string
		lines    []string
		trailing bool
	}{
		{"empty", "", nil, false},
		{"no newline", "a", []string{"a"}, false},
		{"trailing newline", "a\n", []string{"a"}, true},
		{"only newline", "\n", []string{""}, true},
		{"crlf", "a\r\nb\r\n", []string{"a", "b"}, true},
		{"blank line", "a\n\nb\n", []string{"a", "", "b"}, true},
	}
	for _, testCase := range cases {
		lines, trailing := splitContentLines([]byte(testCase.input))
		if strings.Join(lines, "\x00") != strings.Join(testCase.lines, "\x00") || trailing != testCase.trailing {
			t.Fatalf("%s: got (%q, %v), want (%q, %v)", testCase.name, lines, trailing, testCase.lines, testCase.trailing)
		}
	}
}

func TestIsBinaryContent(t *testing.T) {
	if isBinaryContent([]byte("plain text\n")) {
		t.Fatal("plain text was treated as binary")
	}
	if !isBinaryContent([]byte("a\x00b")) {
		t.Fatal("NUL byte was not treated as binary")
	}
	lateNUL := strings.Repeat("a", 9000) + "\x00"
	if isBinaryContent([]byte(lateNUL)) {
		t.Fatal("a NUL past git's sniff window must not be treated as binary")
	}
}

func TestIsObjectID(t *testing.T) {
	cases := map[string]bool{
		"":                      false,
		"abc":                   false,
		strings.Repeat("a", 39): false,
		strings.Repeat("a", 40): true,
		strings.Repeat("f", 64): true,
		strings.Repeat("g", 40): false,
		"ABCDEF0123456789ABCDEF0123456789ABCDEF01": true,
	}
	for value, want := range cases {
		if got := isObjectID(value); got != want {
			t.Fatalf("isObjectID(%q) = %v, want %v", value, got, want)
		}
	}
}

func TestWithin(t *testing.T) {
	cases := []struct {
		base, target string
		want         bool
	}{
		{"/a", "/a", true},
		{"/a", "/a/b", true},
		{"/a", "/ab", false},
		{"", "/a", false},
	}
	for _, testCase := range cases {
		if got := within(testCase.base, testCase.target); got != testCase.want {
			t.Fatalf("within(%q, %q) = %v, want %v", testCase.base, testCase.target, got, testCase.want)
		}
	}
}

func TestParseStatus(t *testing.T) {
	entries := parseStatus("?? a.txt\x00 M b.txt\x00bad\x00")
	if len(entries) != 2 {
		t.Fatalf("unexpected entries: %+v", entries)
	}
	if entries[0].code != "??" || entries[0].path != "a.txt" {
		t.Fatalf("unexpected first entry: %+v", entries[0])
	}
	if entries[1].code != " M" || entries[1].path != "b.txt" {
		t.Fatalf("unexpected second entry: %+v", entries[1])
	}
}

func TestExpandBraces(t *testing.T) {
	cases := []struct {
		input string
		want  []string
	}{
		{"{a,b}", []string{"a", "b"}},
		{"x{a,b}y", []string{"xay", "xby"}},
		{"plain", []string{"plain"}},
		{"a{b", []string{"a{b"}},
	}
	for _, testCase := range cases {
		got := expandBraces(testCase.input)
		if strings.Join(got, "\x00") != strings.Join(testCase.want, "\x00") {
			t.Fatalf("expandBraces(%q) = %v, want %v", testCase.input, got, testCase.want)
		}
	}
}

func TestNormalizeRepoPath(t *testing.T) {
	cases := map[string]string{
		"a/b.txt":    "a/b.txt",
		"./a/b.txt":  "a/b.txt",
		"/a/b.txt":   "a/b.txt",
		"a\\b.txt":   "a/b.txt",
		"a/../b.txt": "",
		"..":         "",
		".":          "",
		"":           "",
	}
	for input, want := range cases {
		if got := normalizeRepoPath(input); got != want {
			t.Fatalf("normalizeRepoPath(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestTruncateText(t *testing.T) {
	if got := truncateText("short", 100); got != "short" {
		t.Fatalf("short text changed: %q", got)
	}
	if got := truncateText("a\nb\n", 3); got != "a" {
		t.Fatalf("line truncation = %q", got)
	}
	if got := truncateText("abcdef", 3); got != "abc" {
		t.Fatalf("byte truncation = %q", got)
	}
	if got := truncateText("a\u00e9\u00e9\u00e9", 3); got != "a\u00e9" {
		t.Fatalf("utf8 truncation = %q", got)
	}
}

func TestExcerptHandlesLongMultibyteLines(t *testing.T) {
	line := "needle" + "a" + strings.Repeat("\u00e9", 300)
	got := excerpt(line)
	if len(got) > 240 {
		t.Fatalf("excerpt is %d bytes", len(got))
	}
	if !utf8.ValidString(got) {
		t.Fatalf("excerpt split a rune: %q", got)
	}
	if !strings.HasPrefix(got, "needle") {
		t.Fatalf("excerpt lost its prefix: %q", got)
	}
}

func TestMergeExcludedDeduplicatesAndSorts(t *testing.T) {
	merged := mergeExcluded(
		[]reviewcore.ExcludedEntry{{Path: "b", Side: reviewcore.SideNew, Reason: reviewcore.ExcludeBinary}},
		[]reviewcore.ExcludedEntry{
			{Path: "a", Side: reviewcore.SideOld, Reason: reviewcore.ExcludeSecret},
			{Path: "b", Side: reviewcore.SideNew, Reason: reviewcore.ExcludeBinary},
		},
	)
	if len(merged) != 2 {
		t.Fatalf("unexpected merged entries: %+v", merged)
	}
	if merged[0].Path != "a" || merged[1].Path != "b" {
		t.Fatalf("entries are not sorted: %+v", merged)
	}
}
