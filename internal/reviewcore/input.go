// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package reviewcore

import (
	"fmt"
	"strings"

	"github.com/bmatcuk/doublestar/v4"
)

// NormalizeInput validates and normalizes one input mode.
func NormalizeInput(spec *InputSpec) (InputSpec, error) {
	if spec == nil {
		return InputSpec{}, Errorf(CodeInvalidInput, "input is required")
	}
	mode := strings.ToLower(strings.TrimSpace(spec.Mode))
	out := InputSpec{
		Mode:   mode,
		From:   strings.TrimSpace(spec.From),
		To:     strings.TrimSpace(spec.To),
		Commit: strings.TrimSpace(spec.Commit),
	}
	switch mode {
	case ModeRange:
		if out.From == "" || out.To == "" {
			return InputSpec{}, Errorf(CodeInvalidInput, "range input requires from and to")
		}
		if out.Commit != "" {
			return InputSpec{}, Errorf(CodeInvalidInput, "range input must not set commit")
		}
	case ModeCommit:
		if out.Commit == "" {
			return InputSpec{}, Errorf(CodeInvalidInput, "commit input requires commit")
		}
		if out.From != "" || out.To != "" {
			return InputSpec{}, Errorf(CodeInvalidInput, "commit input must not set from or to")
		}
	case ModeWorkspace:
		if out.From != "" || out.To != "" || out.Commit != "" {
			return InputSpec{}, Errorf(CodeInvalidInput, "workspace input must not set refs")
		}
	default:
		return InputSpec{}, Errorf(CodeInvalidInput, "unknown input mode %q", spec.Mode)
	}
	for _, value := range []string{out.From, out.To, out.Commit} {
		if err := validateRef(value); err != nil {
			return InputSpec{}, err
		}
	}
	return out, nil
}

func validateRef(ref string) error {
	if ref == "" {
		return nil
	}
	if strings.ContainsAny(ref, "\x00\n\r") {
		return Errorf(CodeInvalidInput, "input ref contains control characters")
	}
	if strings.HasPrefix(ref, "-") {
		return Errorf(CodeInvalidInput, "input ref must not start with '-'")
	}
	if len(ref) > 512 {
		return Errorf(CodeInvalidInput, "input ref is too long")
	}
	return nil
}

// NormalizeScope applies defaults and validates glob patterns.
func NormalizeScope(spec *ScopeSpec) (Scope, error) {
	scope := Scope{IncludeTests: true, IncludeDeleted: true}
	if spec != nil {
		if spec.IncludeTests != nil {
			scope.IncludeTests = *spec.IncludeTests
		}
		if spec.IncludeDeleted != nil {
			scope.IncludeDeleted = *spec.IncludeDeleted
		}
		scope.Include = cleanPatterns(spec.Include)
		scope.Exclude = cleanPatterns(spec.Exclude)
	}
	for _, pattern := range append(append([]string{}, scope.Include...), scope.Exclude...) {
		if _, err := doublestar.Match(pattern, "probe"); err != nil {
			return Scope{}, Errorf(CodeInvalidArgument, "invalid glob pattern %q: %v", pattern, err)
		}
	}
	return scope, nil
}

func cleanPatterns(patterns []string) []string {
	out := make([]string, 0, len(patterns))
	for _, pattern := range patterns {
		pattern = strings.TrimSpace(strings.ReplaceAll(pattern, "\\", "/"))
		if pattern != "" {
			out = append(out, pattern)
		}
	}
	return out
}

// ValidateRequestKey enforces the retry-key contract shared by all writes.
func ValidateRequestKey(key string) error {
	if key == "" {
		return Errorf(CodeInvalidArgument, "request_key is required")
	}
	if len(key) > 200 {
		return Errorf(CodeInvalidArgument, "request_key is longer than 200 bytes")
	}
	if strings.ContainsAny(key, "\x00\n\r\t") {
		return Errorf(CodeInvalidArgument, "request_key must not contain control characters")
	}
	return nil
}

// NormalizePrepare validates a preparation request. Input may be omitted only
// when resume_from supplies the original input.
func NormalizePrepare(req PrepareRequest) (PrepareRequest, error) {
	req.Background = strings.TrimSpace(req.Background)
	req.ResumeFrom = strings.TrimSpace(req.ResumeFrom)
	if err := ValidateRequestKey(req.RequestKey); err != nil {
		return PrepareRequest{}, err
	}
	if req.Input == nil && req.ResumeFrom == "" {
		return PrepareRequest{}, Errorf(CodeInvalidInput, "input or resume_from is required")
	}
	if req.Input != nil {
		normalized, err := NormalizeInput(req.Input)
		if err != nil {
			return PrepareRequest{}, err
		}
		req.Input = &normalized
	}
	if _, err := NormalizeScope(req.Scope); err != nil {
		return PrepareRequest{}, err
	}
	return req, nil
}

// SameInput reports whether two normalized inputs are identical.
func SameInput(a, b InputSpec) bool { return a == b }

// SameScope reports whether two normalized scopes are identical.
func SameScope(a, b Scope) bool {
	if a.IncludeTests != b.IncludeTests || a.IncludeDeleted != b.IncludeDeleted ||
		len(a.Include) != len(b.Include) || len(a.Exclude) != len(b.Exclude) {
		return false
	}
	for i := range a.Include {
		if a.Include[i] != b.Include[i] {
			return false
		}
	}
	for i := range a.Exclude {
		if a.Exclude[i] != b.Exclude[i] {
			return false
		}
	}
	return true
}

func inputDescription(in InputSpec) string {
	switch in.Mode {
	case ModeRange:
		return fmt.Sprintf("range %s..%s", in.From, in.To)
	case ModeCommit:
		return "commit " + in.Commit
	default:
		return "workspace"
	}
}
