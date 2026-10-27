// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package reviewrepo

import (
	"context"
	"strings"
	"testing"

	"github.com/KonghaYao/open-code-review/internal/reviewcore"
)

// memoryStore is the smallest Store that lets the review service run.
type memoryStore struct {
	runs map[string]*reviewcore.Run
}

func (s *memoryStore) CreateRun(_ context.Context, run *reviewcore.Run, _, _ string) (*reviewcore.Run, bool, error) {
	s.runs[run.ReviewID] = run
	return run, true, nil
}

func (s *memoryStore) LoadRun(_ context.Context, reviewID string) (*reviewcore.Run, error) {
	run, ok := s.runs[reviewID]
	if !ok {
		return nil, reviewcore.Errorf(reviewcore.CodeRunNotFound, "run %s not found", reviewID)
	}
	return run, nil
}

func (s *memoryStore) UpdateRun(_ context.Context, reviewID string, update func(*reviewcore.Run) error) (*reviewcore.Run, error) {
	run, ok := s.runs[reviewID]
	if !ok {
		return nil, reviewcore.Errorf(reviewcore.CodeRunNotFound, "run %s not found", reviewID)
	}
	if err := update(run); err != nil {
		return nil, err
	}
	return run, nil
}

type staticAssets struct{}

func (staticAssets) Skill() reviewcore.AssetDoc    { return reviewcore.AssetDoc{Name: "skill"} }
func (staticAssets) Agents() []reviewcore.AssetDoc { return nil }
func (staticAssets) Digest() string                { return "assets-v1" }

// TestServiceIntegration drives the real review service through this adapter,
// which is the only way to prove the Reader contract is satisfied end to end.
func TestServiceIntegration(t *testing.T) {
	tr := newTestRepo(t)
	tr.write("a.txt", "one\ntwo\nneedle\n")
	tr.write(projectRulePath, `{"rules":[{"path":"*.txt","rule":"text rule"}]}`)
	tr.commit("base")
	tr.write("a.txt", "one\nTWO\nneedle\nthree\n")

	repo := tr.newRepo(Options{})
	store := &memoryStore{runs: map[string]*reviewcore.Run{}}
	service, err := reviewcore.NewService(reviewcore.Config{Repo: repo, Store: store, Assets: staticAssets{}})
	if err != nil {
		t.Fatalf("NewService: %v", err)
	}
	ctx := context.Background()

	prepared, err := service.Prepare(ctx, reviewcore.PrepareRequest{
		Input:      &reviewcore.InputSpec{Mode: reviewcore.ModeWorkspace},
		RequestKey: "req-1",
	})
	if err != nil {
		t.Fatalf("Prepare: %v", err)
	}
	if prepared.Snapshot.Mode != reviewcore.ModeWorkspace || prepared.Counts.Changes != 1 {
		t.Fatalf("unexpected preparation: %+v", prepared.Snapshot)
	}
	if prepared.RulesDigest == "" || len(prepared.Units) < 2 {
		t.Fatalf("unexpected preparation result: %+v", prepared)
	}

	var fileUnit reviewcore.UnitSummary
	for _, unit := range prepared.Units {
		if unit.Kind == reviewcore.UnitFile {
			fileUnit = unit
			break
		}
	}
	if fileUnit.ID == "" {
		t.Fatalf("no file unit in %+v", prepared.Units)
	}

	detail, err := service.Context(ctx, reviewcore.ContextRequest{
		ReviewID: prepared.ReviewID, Kind: "unit", UnitID: fileUnit.ID,
	})
	if err != nil {
		t.Fatalf("Context(unit): %v", err)
	}
	if detail.Unit == nil || detail.Unit.Diff == "" {
		t.Fatalf("unexpected unit detail: %+v", detail)
	}
	if len(detail.Unit.Rules) == 0 || detail.Unit.Rules[0].Text != "text rule" {
		t.Fatalf("project rules did not reach the unit: %+v", detail.Unit.Rules)
	}

	manifest, err := service.Context(ctx, reviewcore.ContextRequest{ReviewID: prepared.ReviewID, Kind: "manifest"})
	if err != nil {
		t.Fatalf("Context(manifest): %v", err)
	}
	if manifest.Manifest == nil || manifest.Manifest.TotalChanges != 1 || manifest.Manifest.TotalUnits != len(prepared.Units) {
		t.Fatalf("unexpected manifest: %+v", manifest.Manifest)
	}

	file, err := service.Context(ctx, reviewcore.ContextRequest{
		ReviewID: prepared.ReviewID, Kind: "file", Path: "a.txt", Limit: 10,
	})
	if err != nil {
		t.Fatalf("Context(file): %v", err)
	}
	if file.File == nil || !strings.Contains(file.File.Content, "TWO") || file.File.TotalLines != 4 {
		t.Fatalf("unexpected file view: %+v", file.File)
	}

	search, err := service.Context(ctx, reviewcore.ContextRequest{
		ReviewID: prepared.ReviewID, Kind: "search", Query: "needle",
	})
	if err != nil {
		t.Fatalf("Context(search): %v", err)
	}
	if search.Search == nil || search.Search.Total != 1 || len(search.Search.Matches) != 1 {
		t.Fatalf("unexpected search view: %+v", search.Search)
	}
	if search.Search.Matches[0].Path != "a.txt" || search.Search.Matches[0].Line != 3 {
		t.Fatalf("unexpected search match: %+v", search.Search.Matches[0])
	}

	run := store.runs[prepared.ReviewID]
	changeID := run.Snapshot.Changes[0].ID
	diff, err := service.Context(ctx, reviewcore.ContextRequest{
		ReviewID: prepared.ReviewID, Kind: "diff", ChangeID: changeID,
	})
	if err != nil {
		t.Fatalf("Context(diff): %v", err)
	}
	if diff.Diff == nil || !strings.Contains(diff.Diff.Content, "+TWO") {
		t.Fatalf("unexpected diff view: %+v", diff.Diff)
	}

	rules, err := service.Context(ctx, reviewcore.ContextRequest{
		ReviewID: prepared.ReviewID, Kind: "rules", Path: "a.txt",
	})
	if err != nil {
		t.Fatalf("Context(rules): %v", err)
	}
	if len(rules.Rules) != 1 || rules.Rules[0].Source != projectSource {
		t.Fatalf("unexpected rule view: %+v", rules.Rules)
	}
}
