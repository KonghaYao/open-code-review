// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package reviewrepo

import (
	"regexp"
	"strconv"
	"strings"

	"github.com/KonghaYao/open-code-review/internal/reviewcore"
)

// Change statuses. They follow git's own vocabulary because the parsed diff is
// the only source of truth for a snapshot change.
const (
	statusAdded    = "added"
	statusModified = "modified"
	statusDeleted  = "deleted"
	statusRenamed  = "renamed"
	statusCopied   = "copied"
)

var hunkHeaderRe = regexp.MustCompile(`^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@`)

// diffBlock is one "diff --git" section after parsing.
type diffBlock struct {
	oldPath    string
	newPath    string
	status     string
	binary     bool
	insertions int
	deletions  int
	hunks      []reviewcore.Hunk
	text       string
	truncated  bool
}

// parseUnifiedDiff splits raw git diff text into per-file blocks. Lines before
// the first "diff --git" header (stderr warnings leaked into the stream) are
// ignored, and a block is cut on a line boundary when it exceeds maxBytes.
func parseUnifiedDiff(text string, maxBytes int) []diffBlock {
	lines := splitDiffText(text)
	var blocks []diffBlock
	var current []string
	flush := func() {
		if len(current) == 0 {
			return
		}
		blocks = append(blocks, parseDiffBlock(current, maxBytes))
		current = nil
	}
	for _, line := range lines {
		if strings.HasPrefix(line, "diff --git ") {
			flush()
			current = append(current, line)
			continue
		}
		if current == nil {
			continue
		}
		current = append(current, line)
	}
	flush()
	return blocks
}

func splitDiffText(text string) []string {
	if text == "" {
		return nil
	}
	lines := strings.Split(text, "\n")
	for i, line := range lines {
		lines[i] = strings.TrimSuffix(line, "\r")
	}
	if len(lines) > 0 && lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	return lines
}

func parseDiffBlock(lines []string, maxBytes int) diffBlock {
	block := diffBlock{}
	if truncated, ok := truncateDiffLines(lines, maxBytes); ok {
		lines = truncated
		block.truncated = true
	}
	block.text = strings.Join(lines, "\n")

	var headerOld, headerNew string
	var renameFrom, renameTo string
	var copyFrom, copyTo string
	var explicitStatus string

	for i := 0; i < len(lines); i++ {
		line := lines[i]
		if i == 0 {
			headerOld, headerNew = parseDiffHeaderPaths(line)
			continue
		}
		if strings.HasPrefix(line, "@@") {
			hunk, ok := parseHunkHeader(line)
			if !ok {
				continue
			}
			for i+1 < len(lines) {
				next := lines[i+1]
				if strings.HasPrefix(next, "@@") || strings.HasPrefix(next, "diff --git ") {
					break
				}
				i++
				if next == "" {
					continue
				}
				if strings.HasPrefix(next, `\ No newline at end of file`) {
					// The marker is metadata, not a content line. Keeping it in
					// the hunk would advance the new-side line counter used by
					// reviewcore and shift every following unit line.
					continue
				}
				hunk.Lines = append(hunk.Lines, next)
				switch {
				case strings.HasPrefix(next, "+"):
					block.insertions++
				case strings.HasPrefix(next, "-"):
					block.deletions++
				}
			}
			block.hunks = append(block.hunks, hunk)
			continue
		}
		switch {
		case strings.HasPrefix(line, "new file mode "):
			explicitStatus = statusAdded
		case strings.HasPrefix(line, "deleted file mode "):
			explicitStatus = statusDeleted
		case strings.HasPrefix(line, "rename from "):
			renameFrom = parseGitPath(strings.TrimPrefix(line, "rename from "))
			explicitStatus = statusRenamed
		case strings.HasPrefix(line, "rename to "):
			renameTo = parseGitPath(strings.TrimPrefix(line, "rename to "))
			explicitStatus = statusRenamed
		case strings.HasPrefix(line, "copy from "):
			copyFrom = parseGitPath(strings.TrimPrefix(line, "copy from "))
			explicitStatus = statusCopied
		case strings.HasPrefix(line, "copy to "):
			copyTo = parseGitPath(strings.TrimPrefix(line, "copy to "))
			explicitStatus = statusCopied
		case strings.HasPrefix(line, "Binary files "), strings.HasPrefix(line, "GIT binary patch"):
			block.binary = true
		case strings.HasPrefix(line, "--- "):
			headerOld = parsePrefixedPath(strings.TrimPrefix(line, "--- "), "a/")
		case strings.HasPrefix(line, "+++ "):
			headerNew = parsePrefixedPath(strings.TrimPrefix(line, "+++ "), "b/")
		}
	}

	oldPath, newPath := headerOld, headerNew
	switch {
	case renameFrom != "" || renameTo != "":
		oldPath, newPath = renameFrom, renameTo
	case copyFrom != "" || copyTo != "":
		oldPath, newPath = copyFrom, copyTo
	}
	status := explicitStatus
	if status == "" {
		switch {
		case oldPath == "" && newPath != "":
			status = statusAdded
		case newPath == "" && oldPath != "":
			status = statusDeleted
		case oldPath == "" && newPath == "":
			status = statusModified
		default:
			status = statusModified
		}
	}
	// Binary blocks carry no ---/+++ lines, so /dev/null is only visible from
	// the mode header that accompanies an add or a delete.
	switch status {
	case statusAdded:
		oldPath = ""
	case statusDeleted:
		newPath = ""
	}
	if oldPath == "" && newPath == "" {
		oldPath, newPath = headerOld, headerNew
	}

	block.oldPath = oldPath
	block.newPath = newPath
	block.status = status
	return block
}

func parseHunkHeader(line string) (reviewcore.Hunk, bool) {
	match := hunkHeaderRe.FindStringSubmatch(line)
	if match == nil {
		return reviewcore.Hunk{}, false
	}
	oldStart, _ := strconv.Atoi(match[1])
	oldCount := 1
	if match[2] != "" {
		oldCount, _ = strconv.Atoi(match[2])
	}
	newStart, _ := strconv.Atoi(match[3])
	newCount := 1
	if match[4] != "" {
		newCount, _ = strconv.Atoi(match[4])
	}
	return reviewcore.Hunk{
		OldStart: oldStart,
		OldCount: oldCount,
		NewStart: newStart,
		NewCount: newCount,
		Header:   line,
	}, true
}

func truncateDiffLines(lines []string, maxBytes int) ([]string, bool) {
	if maxBytes <= 0 {
		return lines, false
	}
	total := 0
	for i, line := range lines {
		total += len(line) + 1
		if total > maxBytes {
			if i == 0 {
				return lines[:1], true
			}
			return lines[:i], true
		}
	}
	return lines, false
}

// parseDiffHeaderPaths extracts both pathnames from a "diff --git" line.
func parseDiffHeaderPaths(line string) (string, string) {
	rest := strings.TrimPrefix(line, "diff --git ")
	if first, second, ok := splitHeaderPaths(rest); ok {
		return trimDiffPrefix(first, "a/"), trimDiffPrefix(second, "b/")
	}
	// Fallback for unquoted names: the two sides are separated by " b/".
	if index := strings.Index(rest, " b/"); index > 0 && strings.HasPrefix(rest, "a/") {
		return rest[2:index], rest[index+3:]
	}
	return "", ""
}

func parsePrefixedPath(field, prefix string) string {
	field = strings.TrimSpace(field)
	path := parseGitPath(field)
	if path == "/dev/null" {
		return ""
	}
	return trimDiffPrefix(path, prefix)
}

// trimDiffPrefix removes the fixed a/ or b/ side prefix exactly once. The other
// side's prefix is stripped as a fallback because a pathname may legitimately
// begin with those bytes after its own prefix has been removed.
func trimDiffPrefix(path, prefix string) string {
	if strings.HasPrefix(path, prefix) {
		return path[len(prefix):]
	}
	other := "b/"
	if prefix == "b/" {
		other = "a/"
	}
	if strings.HasPrefix(path, other) {
		return path[len(other):]
	}
	return path
}

func parseGitPath(field string) string {
	field = strings.TrimSpace(field)
	if field == "" {
		return ""
	}
	if strings.HasPrefix(field, "\"") {
		// A decoded path may legitimately contain a tab, so the tab-strip
		// below must not run on the decoded value.
		if decoded, _, ok := unquoteGitPath(field); ok {
			return decoded
		}
		return field
	}
	if index := strings.IndexByte(field, '\t'); index >= 0 {
		field = field[:index]
	}
	return strings.TrimSpace(field)
}

// splitHeaderPaths splits the text after "diff --git " into its two pathnames,
// each still carrying its a/ or b/ prefix. A bare name cannot contain a double
// quote, so the first quote opens the second name whenever the first is bare.
func splitHeaderPaths(rest string) (string, string, bool) {
	if strings.HasPrefix(rest, `"`) {
		first, after, ok := unquoteGitPath(rest)
		if !ok {
			return "", "", false
		}
		after, ok = strings.CutPrefix(after, " ")
		if !ok {
			return "", "", false
		}
		if strings.HasPrefix(after, `"`) {
			second, tail, ok := unquoteGitPath(after)
			if !ok || tail != "" {
				return "", "", false
			}
			return first, second, true
		}
		return first, after, true
	}
	quote := strings.Index(rest, `"`)
	if quote <= 0 || rest[quote-1] != ' ' {
		return "", "", false
	}
	second, tail, ok := unquoteGitPath(rest[quote:])
	if !ok || tail != "" {
		return "", "", false
	}
	return rest[:quote-1], second, true
}

// unquoteGitPath decodes one C-style quoted pathname. Decoding stays
// byte-oriented because a multibyte character arrives as one octal escape per
// byte and only reassembles once those bytes sit next to each other again.
func unquoteGitPath(s string) (string, string, bool) {
	if len(s) == 0 || s[0] != '"' {
		return "", s, false
	}
	var b strings.Builder
	for i := 1; i < len(s); i++ {
		c := s[i]
		switch {
		case c == '"':
			return b.String(), s[i+1:], true
		case c != '\\':
			b.WriteByte(c)
		default:
			i++
			if i >= len(s) {
				return "", s, false
			}
			switch e := s[i]; e {
			case 'a':
				b.WriteByte('\a')
			case 'b':
				b.WriteByte('\b')
			case 'f':
				b.WriteByte('\f')
			case 'n':
				b.WriteByte('\n')
			case 'r':
				b.WriteByte('\r')
			case 't':
				b.WriteByte('\t')
			case 'v':
				b.WriteByte('\v')
			case '"', '\\':
				b.WriteByte(e)
			case '0', '1', '2', '3', '4', '5', '6', '7':
				if i+2 >= len(s) {
					return "", s, false
				}
				value := 0
				for d := 0; d < 3; d++ {
					digit := s[i+d]
					if digit < '0' || digit > '7' {
						return "", s, false
					}
					value = value*8 + int(digit-'0')
				}
				if value > 0xff {
					return "", s, false
				}
				i += 2
				b.WriteByte(byte(value))
			default:
				return "", s, false
			}
		}
	}
	return "", s, false
}

// quoteGitPath emits a C-quoted pathname when the raw bytes cannot survive a
// single diff header line. Synthetic untracked blocks are the only writers, and
// they must round-trip through the same parser git output uses.
func quoteGitPath(path string) string {
	needsQuote := false
	for i := 0; i < len(path); i++ {
		c := path[i]
		if c < 0x20 || c == 0x7f || c == '"' || c == '\\' {
			needsQuote = true
			break
		}
	}
	if !needsQuote {
		return path
	}
	var b strings.Builder
	b.WriteByte('"')
	for i := 0; i < len(path); i++ {
		switch c := path[i]; c {
		case '\a':
			b.WriteString(`\a`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		case '\v':
			b.WriteString(`\v`)
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		default:
			if c < 0x20 || c == 0x7f {
				b.WriteByte('\\')
				b.WriteByte('0' + (c>>6)&7)
				b.WriteByte('0' + (c>>3)&7)
				b.WriteByte('0' + c&7)
				continue
			}
			b.WriteByte(c)
		}
	}
	b.WriteByte('"')
	return b.String()
}
