// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package reviewrepo

import (
	"strings"
	"testing"
)

func parseOne(t *testing.T, text string) diffBlock {
	t.Helper()
	blocks := parseUnifiedDiff(text, 1<<20)
	if len(blocks) != 1 {
		t.Fatalf("expected one block, got %d", len(blocks))
	}
	return blocks[0]
}

func TestParseUnifiedDiffAddition(t *testing.T) {
	block := parseOne(t, `diff --git a/added.txt b/added.txt
new file mode 100644
index 0000000..e69de29
--- /dev/null
+++ b/added.txt
@@ -0,0 +1,2 @@
+hi
+there
`)
	if block.status != statusAdded || block.oldPath != "" || block.newPath != "added.txt" {
		t.Fatalf("unexpected header: %+v", block)
	}
	if block.insertions != 2 || block.deletions != 0 || len(block.hunks) != 1 {
		t.Fatalf("unexpected accounting: %+v", block)
	}
	hunk := block.hunks[0]
	if hunk.OldStart != 0 || hunk.OldCount != 0 || hunk.NewStart != 1 || hunk.NewCount != 2 {
		t.Fatalf("unexpected hunk: %+v", hunk)
	}
	if hunk.Header != "@@ -0,0 +1,2 @@" {
		t.Fatalf("unexpected hunk header %q", hunk.Header)
	}
}

func TestParseUnifiedDiffDeletion(t *testing.T) {
	block := parseOne(t, `diff --git a/gone.txt b/gone.txt
deleted file mode 100644
index e69de29..0000000
--- a/gone.txt
+++ /dev/null
@@ -1 +0,0 @@
-bye
`)
	if block.status != statusDeleted || block.newPath != "" || block.oldPath != "gone.txt" {
		t.Fatalf("unexpected header: %+v", block)
	}
	if block.deletions != 1 {
		t.Fatalf("unexpected deletions: %+v", block)
	}
	if block.hunks[0].OldCount != 1 || block.hunks[0].NewCount != 0 {
		t.Fatalf("omitted counts must default to one: %+v", block.hunks[0])
	}
}

func TestParseUnifiedDiffRenameAndCopy(t *testing.T) {
	renamed := parseOne(t, `diff --git a/old name.txt b/new name.txt
similarity index 90%
rename from old name.txt
rename to new name.txt
`)
	if renamed.status != statusRenamed || renamed.oldPath != "old name.txt" || renamed.newPath != "new name.txt" {
		t.Fatalf("unexpected rename: %+v", renamed)
	}

	copied := parseOne(t, `diff --git a/a.txt b/b.txt
similarity index 100%
copy from a.txt
copy to b.txt
`)
	if copied.status != statusCopied || copied.oldPath != "a.txt" || copied.newPath != "b.txt" {
		t.Fatalf("unexpected copy: %+v", copied)
	}
}

func TestParseUnifiedDiffBinaryAndModeOnly(t *testing.T) {
	binary := parseOne(t, `diff --git a/bin.dat b/bin.dat
index 1111111..2222222 100644
Binary files a/bin.dat and b/bin.dat differ
`)
	if !binary.binary || binary.status != statusModified || binary.oldPath != "bin.dat" || binary.newPath != "bin.dat" {
		t.Fatalf("unexpected binary block: %+v", binary)
	}

	patch := parseOne(t, `diff --git a/obj.bin b/obj.bin
new file mode 100644
GIT binary patch
literal 4
Lc$@N00
`)
	if !patch.binary || patch.status != statusAdded || patch.oldPath != "" {
		t.Fatalf("unexpected binary patch: %+v", patch)
	}

	modeOnly := parseOne(t, `diff --git a/run.sh b/run.sh
old mode 100644
new mode 100755
`)
	if modeOnly.status != statusModified || len(modeOnly.hunks) != 0 || modeOnly.oldPath != "run.sh" {
		t.Fatalf("unexpected mode-only block: %+v", modeOnly)
	}
}

func TestParseUnifiedDiffQuotedPaths(t *testing.T) {
	renamed := parseOne(t, `diff --git "a/tab\tname.txt" "b/new\tname.txt"
similarity index 100%
rename from "tab\tname.txt"
rename to "new\tname.txt"
`)
	if renamed.oldPath != "tab\tname.txt" || renamed.newPath != "new\tname.txt" {
		t.Fatalf("quoted rename paths were not decoded: %+v", renamed)
	}

	octal := parseOne(t, `diff --git "a/caf\303\251.txt" "b/caf\303\251.txt"
--- "a/caf\303\251.txt"
+++ "b/caf\303\251.txt"
@@ -1 +1 @@
-old
+new
`)
	if octal.oldPath != "caf\u00e9.txt" || octal.newPath != "caf\u00e9.txt" {
		t.Fatalf("octal escapes were not reassembled: %+v", octal)
	}

	mixed := parseOne(t, `diff --git a/plain.txt "b/tab\tname.txt"
--- a/plain.txt
+++ "b/tab\tname.txt"
@@ -1 +1 @@
-old
+new
`)
	if mixed.oldPath != "plain.txt" || mixed.newPath != "tab\tname.txt" {
		t.Fatalf("mixed quoting was not handled: %+v", mixed)
	}
}

func TestParseUnifiedDiffNoNewlineMarker(t *testing.T) {
	block := parseOne(t, `diff --git a/x.txt b/x.txt
--- a/x.txt
+++ b/x.txt
@@ -1 +1 @@
-old
\ No newline at end of file
+new
\ No newline at end of file
`)
	if block.insertions != 1 || block.deletions != 1 {
		t.Fatalf("unexpected accounting: %+v", block)
	}
	if len(block.hunks) != 1 || len(block.hunks[0].Lines) != 2 {
		t.Fatalf("the marker must not become a content line: %+v", block.hunks)
	}
}

func TestParseUnifiedDiffMultipleBlocksAndPreamble(t *testing.T) {
	text := `warning: something happened
diff --git a/one.txt b/one.txt
--- a/one.txt
+++ b/one.txt
@@ -1 +1 @@
-a
+b
diff --git a/two.txt b/two.txt
--- a/two.txt
+++ b/two.txt
@@ -1 +1 @@
-c
+d
`
	blocks := parseUnifiedDiff(text, 1<<20)
	if len(blocks) != 2 || blocks[0].newPath != "one.txt" || blocks[1].newPath != "two.txt" {
		t.Fatalf("unexpected blocks: %+v", blocks)
	}
	if blocks := parseUnifiedDiff("", 1<<20); len(blocks) != 0 {
		t.Fatalf("empty input produced blocks: %+v", blocks)
	}
}

func TestParseUnifiedDiffTruncation(t *testing.T) {
	text := `diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1,4 +1,4 @@
-one
+ONE
-two
+TWO
-three
+THREE
-four
+FOUR
`
	blocks := parseUnifiedDiff(text, 80)
	if len(blocks) != 1 || !blocks[0].truncated {
		t.Fatalf("expected one truncated block: %+v", blocks)
	}
	if len(blocks[0].text) > 80 {
		t.Fatalf("block is %d bytes, expected at most 80", len(blocks[0].text))
	}
	if !strings.HasPrefix(blocks[0].text, "diff --git a/a.txt") {
		t.Fatalf("truncation dropped the header: %q", blocks[0].text)
	}
}

func TestParseDiffHeaderPaths(t *testing.T) {
	cases := []struct {
		line string
		old  string
		new  string
	}{
		{"diff --git a/x.txt b/y.txt", "x.txt", "y.txt"},
		{`diff --git "a/x y.txt" "b/x y.txt"`, "x y.txt", "x y.txt"},
		{"diff --git a/x y.txt b/x y.txt", "x y.txt", "x y.txt"},
		{"diff --git nonsense", "", ""},
		{`diff --git "a/unterminated b/x`, "", ""},
	}
	for _, testCase := range cases {
		old, new := parseDiffHeaderPaths(testCase.line)
		if old != testCase.old || new != testCase.new {
			t.Fatalf("%q: got (%q, %q), want (%q, %q)", testCase.line, old, new, testCase.old, testCase.new)
		}
	}
}

func TestSplitHeaderPathsFailures(t *testing.T) {
	cases := []string{
		`"a"`,
		`"a" "b" trailing`,
		`a b"c"`,
	}
	for _, input := range cases {
		if _, _, ok := splitHeaderPaths(input); ok {
			t.Fatalf("splitHeaderPaths(%q) should fail", input)
		}
	}
}

func TestQuoteGitPathRoundTrip(t *testing.T) {
	for _, input := range []string{"tab\tname", `quote"name`, `back\slash`, "new\nline", "\x01control", "bell\aback\bform\fcar\rvert\v"} {
		quoted := quoteGitPath(input)
		decoded, rest, ok := unquoteGitPath(quoted)
		if !ok || rest != "" || decoded != input {
			t.Fatalf("round trip failed for %q via %q: (%q, %q, %v)", input, quoted, decoded, rest, ok)
		}
	}
	for _, plain := range []string{"plain.txt", "with space", "caf\u00e9"} {
		if quoted := quoteGitPath(plain); quoted != plain {
			t.Fatalf("%q should stay unquoted, got %q", plain, quoted)
		}
	}
}

func TestTrimDiffPrefix(t *testing.T) {
	cases := []struct{ path, prefix, want string }{
		{"a/x.txt", "a/", "x.txt"},
		{"b/x.txt", "b/", "x.txt"},
		{"b/x.txt", "a/", "x.txt"},
		{"a/x.txt", "b/", "x.txt"},
		{"x.txt", "a/", "x.txt"},
		{"a/b/x.txt", "a/", "b/x.txt"},
	}
	for _, testCase := range cases {
		if got := trimDiffPrefix(testCase.path, testCase.prefix); got != testCase.want {
			t.Fatalf("trimDiffPrefix(%q, %q) = %q, want %q", testCase.path, testCase.prefix, got, testCase.want)
		}
	}
}
