// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package reviewcore

import (
	"fmt"
	"sort"
	"strings"
)

// ReportURIs returns the stable resource URIs for a sealed or active run.
func ReportURIs(reviewID string) (jsonURI, markdownURI string) {
	base := "review://runs/" + reviewID + "/report"
	return base + ".json", base + ".md"
}

// RenderMarkdown renders a human-readable report. It deliberately prints the
// run status and coverage before findings so a partial run is never mistaken
// for a clean review.
func RenderMarkdown(report *Report) string {
	var b strings.Builder
	fmt.Fprintf(&b, "# Code review report\n\n")
	fmt.Fprintf(&b, "- Review: `%s`\n", report.ReviewID)
	if report.ParentReviewID != "" {
		fmt.Fprintf(&b, "- Resumed from: `%s`\n", report.ParentReviewID)
	}
	fmt.Fprintf(&b, "- Status: **%s**\n", report.Status)
	fmt.Fprintf(&b, "- Input: %s\n", inputDescription(report.Input))
	if report.Snapshot.HeadSHA != "" {
		fmt.Fprintf(&b, "- Snapshot: `%s` (head `%s`)\n", report.Snapshot.ID, report.Snapshot.HeadSHA)
	} else {
		fmt.Fprintf(&b, "- Snapshot: `%s`\n", report.Snapshot.ID)
	}
	fmt.Fprintf(&b, "- Generated: %s\n\n", report.GeneratedAt.UTC().Format("2006-01-02T15:04:05Z"))

	fmt.Fprintf(&b, "## Coverage\n\n")
	fmt.Fprintf(&b, "| Required | Reviewed | Reused | Skipped | Failed | Pending | Complete |\n")
	fmt.Fprintf(&b, "| - | - | - | - | - | - | - |\n")
	fmt.Fprintf(&b, "| %d | %d | %d | %d | %d | %d | %t |\n\n",
		report.Coverage.Required, report.Coverage.Reviewed, report.Coverage.Reused,
		report.Coverage.Skipped, report.Coverage.Failed, report.Coverage.Pending,
		report.Coverage.Complete)

	if report.Background != "" {
		fmt.Fprintf(&b, "## Background\n\n%s\n\n", report.Background)
	}
	if len(report.Gaps) > 0 {
		fmt.Fprintf(&b, "## Gaps\n\n")
		for _, gap := range report.Gaps {
			fmt.Fprintf(&b, "- %s\n", gap)
		}
		b.WriteString("\n")
	}
	if len(report.Excluded) > 0 {
		fmt.Fprintf(&b, "## Excluded files\n\n")
		for _, entry := range report.Excluded {
			fmt.Fprintf(&b, "- `%s` (%s): %s\n", entry.Path, entry.Side, entry.Reason)
		}
		b.WriteString("\n")
	}

	findings := append([]ReportFinding(nil), report.Findings...)
	sort.SliceStable(findings, func(i, j int) bool {
		if findings[i].Priority != findings[j].Priority {
			return findings[i].Priority < findings[j].Priority
		}
		pi, pj := findings[i].Location.Path, findings[j].Location.Path
		if pi != pj {
			return pi < pj
		}
		return findings[i].Location.StartLine < findings[j].Location.StartLine
	})
	fmt.Fprintf(&b, "## Findings (%d)\n\n", len(findings))
	if len(findings) == 0 {
		b.WriteString("No candidate findings were recorded.\n\n")
	}
	for _, finding := range findings {
		verdict := "unverified"
		if finding.LatestVerification != nil {
			verdict = finding.LatestVerification.Verdict
		}
		location := finding.Location.Path
		if finding.Location.StartLine > 0 {
			location = fmt.Sprintf("%s:%d-%d", location, finding.Location.StartLine, finding.Location.EndLine)
		}
		if !finding.Located {
			location += " (unlocated)"
		}
		fmt.Fprintf(&b, "### [%s] %s: %s\n\n", finding.Priority, finding.Category, location)
		fmt.Fprintf(&b, "- Verdict: **%s**\n", verdict)
		fmt.Fprintf(&b, "- Trigger: %s\n", finding.Trigger)
		fmt.Fprintf(&b, "- Impact: %s\n", finding.Impact)
		if finding.Suggestion != "" {
			fmt.Fprintf(&b, "- Suggestion: %s\n", finding.Suggestion)
		}
		if finding.LocateNote != "" {
			fmt.Fprintf(&b, "- Location note: %s\n", finding.LocateNote)
		}
		if finding.LatestVerification != nil && finding.LatestVerification.Rationale != "" {
			fmt.Fprintf(&b, "- Verification: %s\n", finding.LatestVerification.Rationale)
		}
		b.WriteString("\n")
	}
	return b.String()
}
