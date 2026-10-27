// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package reviewcore

import (
	"reflect"
	"strings"
	"testing"
)

func TestNormalizeInput(t *testing.T) {
	tests := []struct {
		name string
		spec *InputSpec
		want InputSpec
		code ErrorCode
	}{
		{
			name: "nil input",
			spec: nil,
			code: CodeInvalidInput,
		},
		{
			name: "range trims and lowercases the mode",
			spec: &InputSpec{Mode: " RANGE ", From: " main ", To: " dev "},
			want: InputSpec{Mode: ModeRange, From: "main", To: "dev"},
		},
		{
			name: "range requires from",
			spec: &InputSpec{Mode: ModeRange, To: "dev"},
			code: CodeInvalidInput,
		},
		{
			name: "range requires to",
			spec: &InputSpec{Mode: ModeRange, From: "main"},
			code: CodeInvalidInput,
		},
		{
			name: "range rejects commit",
			spec: &InputSpec{Mode: ModeRange, From: "main", To: "dev", Commit: "abc"},
			code: CodeInvalidInput,
		},
		{
			name: "commit mode",
			spec: &InputSpec{Mode: "COMMIT", Commit: "abc123"},
			want: InputSpec{Mode: ModeCommit, Commit: "abc123"},
		},
		{
			name: "commit requires commit",
			spec: &InputSpec{Mode: ModeCommit},
			code: CodeInvalidInput,
		},
		{
			name: "commit rejects from and to",
			spec: &InputSpec{Mode: ModeCommit, Commit: "abc", From: "main"},
			code: CodeInvalidInput,
		},
		{
			name: "workspace mode",
			spec: &InputSpec{Mode: " Workspace "},
			want: InputSpec{Mode: ModeWorkspace},
		},
		{
			name: "workspace rejects refs",
			spec: &InputSpec{Mode: ModeWorkspace, From: "main", To: "dev", Commit: "abc"},
			code: CodeInvalidInput,
		},
		{
			name: "unknown mode",
			spec: &InputSpec{Mode: "branch"},
			code: CodeInvalidInput,
		},
		{
			name: "ref with newline",
			spec: &InputSpec{Mode: ModeRange, From: "ma\nin", To: "dev"},
			code: CodeInvalidInput,
		},
		{
			name: "ref with NUL",
			spec: &InputSpec{Mode: ModeCommit, Commit: "abc\x00def"},
			code: CodeInvalidInput,
		},
		{
			name: "ref starting with dash",
			spec: &InputSpec{Mode: ModeRange, From: "-main", To: "dev"},
			code: CodeInvalidInput,
		},
		{
			name: "ref longer than 512 bytes",
			spec: &InputSpec{Mode: ModeCommit, Commit: strings.Repeat("a", 513)},
			code: CodeInvalidInput,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := NormalizeInput(test.spec)
			if test.code != "" {
				if !IsCode(err, test.code) {
					t.Fatalf("error = %v, want code %s", err, test.code)
				}
				return
			}
			if err != nil {
				t.Fatalf("NormalizeInput: %v", err)
			}
			if !reflect.DeepEqual(got, test.want) {
				t.Fatalf("NormalizeInput = %+v, want %+v", got, test.want)
			}
		})
	}
}

func TestNormalizeScopeDefaults(t *testing.T) {
	scope, err := NormalizeScope(nil)
	if err != nil {
		t.Fatalf("NormalizeScope: %v", err)
	}
	if !scope.IncludeTests || !scope.IncludeDeleted {
		t.Fatalf("defaults = %+v, want tests and deleted included", scope)
	}
	if len(scope.Include) != 0 || len(scope.Exclude) != 0 {
		t.Fatalf("default patterns = %+v", scope)
	}
}

func TestNormalizeScopePreservesExplicitFalse(t *testing.T) {
	noTests, noDeleted := false, false
	scope, err := NormalizeScope(&ScopeSpec{IncludeTests: &noTests, IncludeDeleted: &noDeleted})
	if err != nil {
		t.Fatalf("NormalizeScope: %v", err)
	}
	if scope.IncludeTests || scope.IncludeDeleted {
		t.Fatalf("explicit false was overwritten: %+v", scope)
	}
}

func TestNormalizeScopeCleansPatterns(t *testing.T) {
	scope, err := NormalizeScope(&ScopeSpec{
		Include: []string{" src/** ", "", "\\vendor\\**", "src/**"},
		Exclude: []string{" docs/ "},
	})
	if err != nil {
		t.Fatalf("NormalizeScope: %v", err)
	}
	// cleanPatterns trims, normalizes separators (including a leading
	// backslash) and drops empty entries. It deliberately does not deduplicate,
	// so the repeated pattern is preserved.
	wantInclude := []string{"src/**", "/vendor/**", "src/**"}
	if !reflect.DeepEqual(scope.Include, wantInclude) {
		t.Fatalf("include = %#v, want %#v", scope.Include, wantInclude)
	}
	if !reflect.DeepEqual(scope.Exclude, []string{"docs/"}) {
		t.Fatalf("exclude = %#v", scope.Exclude)
	}
}

func TestNormalizeScopeRejectsInvalidGlob(t *testing.T) {
	_, err := NormalizeScope(&ScopeSpec{Include: []string{"["}})
	if !IsCode(err, CodeInvalidArgument) {
		t.Fatalf("error = %v, want %s", err, CodeInvalidArgument)
	}
}
