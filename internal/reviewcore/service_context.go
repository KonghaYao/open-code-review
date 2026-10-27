// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package reviewcore

import (
	"context"
	"regexp"
	"strings"
)

var reviewIDPattern = regexp.MustCompile(`^rv_[0-9a-f]{16,64}$`)

func validateReviewID(reviewID string) error {
	if !reviewIDPattern.MatchString(reviewID) {
		return Errorf(CodeInvalidArgument, "invalid review_id")
	}
	return nil
}

// Context reads immutable snapshot content. It never accepts a repository path
// or a ref: the run already binds those.
func (s *Service) Context(ctx context.Context, req ContextRequest) (*ContextResponse, error) {
	if err := validateReviewID(req.ReviewID); err != nil {
		return nil, err
	}
	run, err := s.store.LoadRun(ctx, req.ReviewID)
	if err != nil {
		return nil, err
	}
	if run.Snapshot == nil {
		return nil, Errorf(CodeSnapshotMissing, "run %s has no snapshot", run.ReviewID)
	}
	reader, err := s.repo.Open(run.Snapshot)
	if err != nil {
		return nil, err
	}
	kind := strings.ToLower(strings.TrimSpace(req.Kind))
	if kind == "" {
		kind = "manifest"
	}
	response := &ContextResponse{
		SchemaVersion: SchemaVersion,
		ReviewID:      run.ReviewID,
		SnapshotID:    run.Snapshot.ID,
		Kind:          kind,
	}
	switch kind {
	case "unit":
		err = s.contextUnit(ctx, run, reader, req, response)
	case "diff":
		err = s.contextDiff(ctx, run, reader, req, response)
	case "file":
		err = s.contextFile(ctx, run, reader, req, response)
	case "manifest":
		err = s.contextManifest(ctx, run, req, response)
	case "search":
		err = s.contextSearch(ctx, run, reader, req, response)
	case "rules":
		err = s.contextRules(ctx, run, reader, req, response)
	default:
		return nil, Errorf(CodeInvalidArgument, "unknown context kind %q", req.Kind)
	}
	if err != nil {
		return nil, err
	}
	return response, nil
}

func (s *Service) contextUnit(ctx context.Context, run *Run, reader Reader, req ContextRequest, response *ContextResponse) error {
	unit := findUnit(run, req.UnitID)
	if unit == nil {
		return Errorf(CodeInvalidArgument, "unknown unit_id")
	}
	diff, err := reader.UnitDiff(ctx, *unit)
	if err != nil {
		return err
	}
	if len(diff) > s.maxBodyBytes {
		return Errorf(CodePayloadTooLarge, "unit diff is %d bytes; use kind=diff with pagination", len(diff))
	}
	pack, err := s.repo.Rules(ctx, reader, unit.Paths)
	if err != nil {
		return err
	}
	response.Unit = &UnitDetail{UnitSummary: unit.Summary(), Diff: diff, DiffBytes: len(diff), Rules: pack.Groups}
	return nil
}

func (s *Service) contextDiff(ctx context.Context, run *Run, reader Reader, req ContextRequest, response *ContextResponse) error {
	query := QueryHash("diff", req.UnitID, req.ChangeID)
	offset, _, err := DecodeCursor(req.Cursor, run.ReviewID, run.Snapshot.ID, query)
	if err != nil {
		return err
	}
	var content string
	view := &DiffView{ChangeID: req.ChangeID, UnitID: req.UnitID}
	switch {
	case req.UnitID != "":
		unit := findUnit(run, req.UnitID)
		if unit == nil {
			return Errorf(CodeInvalidArgument, "unknown unit_id")
		}
		content, err = reader.UnitDiff(ctx, *unit)
		if len(unit.Paths) == 1 {
			view.Path = unit.Paths[0]
		}
	case req.ChangeID != "":
		content, err = reader.Diff(ctx, req.ChangeID)
		for _, change := range run.Snapshot.Changes {
			if change.ID == req.ChangeID {
				view.Path = change.EffectivePath()
				break
			}
		}
	default:
		return Errorf(CodeInvalidArgument, "unit_id or change_id is required")
	}
	if err != nil {
		return err
	}
	lines := strings.Split(content, "\n")
	if len(lines) == 1 && lines[0] == "" {
		lines = nil
	}
	start, end, chunk := paginateLines(lines, offset, 2000, s.maxBodyBytes)
	if len(chunk) == 1 && len(chunk[0]) > s.maxBodyBytes {
		return Errorf(CodePayloadTooLarge, "a single diff line exceeds the body limit")
	}
	view.Content = strings.Join(chunk, "\n")
	view.LineStart = start + 1
	view.LineEnd = end
	view.TotalLines = len(lines)
	view.Bytes = len(view.Content)
	response.Diff = view
	if end < len(lines) {
		response.NextCursor = EncodeCursor(run.ReviewID, run.Snapshot.ID, query, end, 0)
	}
	return nil
}

func (s *Service) contextFile(ctx context.Context, run *Run, reader Reader, req ContextRequest, response *ContextResponse) error {
	path := normalizePath(req.Path)
	if path == "" {
		return Errorf(CodeInvalidArgument, "path is required")
	}
	if isSecretPath(path) {
		return Errorf(CodeSecretPath, "secret paths are never readable")
	}
	side := req.Side
	if side == "" {
		side = SideNew
	}
	query := QueryHash("file", path, side)
	offset, _, err := DecodeCursor(req.Cursor, run.ReviewID, run.Snapshot.ID, query)
	if err != nil {
		return err
	}
	start := req.StartLine
	if req.StartLine > 0 {
		start = req.StartLine
	} else if offset > 0 {
		start = offset + 1
	} else {
		start = 1
	}
	limit := ClampLimit(req.Limit, 200, 2000)
	if req.EndLine > 0 {
		if req.EndLine < start {
			return Errorf(CodeInvalidArgument, "end_line must not be before start_line")
		}
		if span := req.EndLine - start + 1; span < limit {
			limit = span
		}
	}
	chunk, err := reader.ReadFileLines(ctx, path, side, start, limit)
	if err != nil {
		return err
	}
	if chunk.Binary {
		return Errorf(CodeBinaryFile, "file is binary and cannot be read as text")
	}
	if len(chunk.Content) > s.maxBodyBytes {
		return Errorf(CodePayloadTooLarge, "file chunk is %d bytes; request fewer lines", len(chunk.Content))
	}
	response.File = &FileView{
		Path: chunk.Path, Side: chunk.Side, Content: chunk.Content,
		LineStart: chunk.LineStart, LineEnd: chunk.LineEnd, TotalLines: chunk.TotalLines,
		Bytes: len(chunk.Content), Digest: chunk.Digest,
	}
	if chunk.LineEnd < chunk.TotalLines {
		response.NextCursor = EncodeCursor(run.ReviewID, run.Snapshot.ID, query, chunk.LineEnd, 0)
	}
	return nil
}

func (s *Service) contextManifest(ctx context.Context, run *Run, req ContextRequest, response *ContextResponse) error {
	query := QueryHash("manifest")
	offset, _, err := DecodeCursor(req.Cursor, run.ReviewID, run.Snapshot.ID, query)
	if err != nil {
		return err
	}
	limit := ClampLimit(req.Limit, s.defaultPageSize, s.maxPageSize)
	changes := make([]ChangeSummary, 0)
	units := make([]UnitSummary, 0)
	changeStart, changeEnd := pageBounds(len(run.Snapshot.Changes), offset, limit)
	for _, change := range run.Snapshot.Changes[changeStart:changeEnd] {
		changes = append(changes, change.Summary())
	}
	unitStart, unitEnd := pageBounds(len(run.Units), offset, limit)
	for _, unit := range run.Units[unitStart:unitEnd] {
		units = append(units, unit.Summary())
	}
	response.Manifest = &ManifestView{
		Changes: changes, Units: units,
		TotalChanges: len(run.Snapshot.Changes), TotalUnits: len(run.Units),
	}
	total := len(run.Snapshot.Changes)
	if len(run.Units) > total {
		total = len(run.Units)
	}
	if changeEnd < len(run.Snapshot.Changes) || unitEnd < len(run.Units) {
		response.NextCursor = EncodeCursor(run.ReviewID, run.Snapshot.ID, query, changeEnd, 0)
		if unitEnd > changeEnd {
			response.NextCursor = EncodeCursor(run.ReviewID, run.Snapshot.ID, query, unitEnd, 0)
		}
	}
	_ = total
	return nil
}

func (s *Service) contextSearch(ctx context.Context, run *Run, reader Reader, req ContextRequest, response *ContextResponse) error {
	queryText := strings.TrimSpace(req.Query)
	if queryText == "" {
		return Errorf(CodeInvalidArgument, "query is required")
	}
	if len(queryText) > 500 {
		return Errorf(CodeInvalidArgument, "query is longer than 500 bytes")
	}
	side := req.Side
	if side == "" {
		side = SideNew
	}
	if side != SideNew && side != SideOld {
		return Errorf(CodeInvalidArgument, "side must be old or new")
	}
	prefix := normalizePath(req.PathPrefix)
	query := QueryHash("search", queryText, side, prefix, boolString(req.CaseSensitive), boolString(req.Regex))
	offset, _, err := DecodeCursor(req.Cursor, run.ReviewID, run.Snapshot.ID, query)
	if err != nil {
		return err
	}
	limit := ClampLimit(req.Limit, 20, 100)
	matches, total, scanned, skipped, err := reader.Search(ctx, SearchOptions{
		Query: queryText, CaseSensitive: req.CaseSensitive, Regex: req.Regex,
		PathPrefix: prefix, Side: side, Offset: offset, Limit: limit,
	})
	if err != nil {
		return err
	}
	response.Search = &SearchView{Query: queryText, Matches: matches, Total: total, ScannedFiles: scanned, SkippedFiles: skipped}
	if offset+len(matches) < total {
		response.NextCursor = EncodeCursor(run.ReviewID, run.Snapshot.ID, query, offset+len(matches), 0)
	}
	return nil
}

func (s *Service) contextRules(ctx context.Context, run *Run, reader Reader, req ContextRequest, response *ContextResponse) error {
	var paths []string
	if req.UnitID != "" {
		unit := findUnit(run, req.UnitID)
		if unit == nil {
			return Errorf(CodeInvalidArgument, "unknown unit_id")
		}
		paths = unit.Paths
	} else if req.Path != "" {
		path := normalizePath(req.Path)
		if isSecretPath(path) {
			return Errorf(CodeSecretPath, "secret paths have no review rules")
		}
		paths = []string{path}
	} else {
		return Errorf(CodeInvalidArgument, "unit_id or path is required")
	}
	query := QueryHash("rules", req.UnitID, normalizePath(req.Path))
	offset, _, err := DecodeCursor(req.Cursor, run.ReviewID, run.Snapshot.ID, query)
	if err != nil {
		return err
	}
	pack, err := s.repo.Rules(ctx, reader, paths)
	if err != nil {
		return err
	}
	limit := ClampLimit(req.Limit, 5, 20)
	start, end := pageBounds(len(pack.Groups), offset, limit)
	response.Rules = append([]RuleGroup(nil), pack.Groups[start:end]...)
	if end < len(pack.Groups) {
		response.NextCursor = EncodeCursor(run.ReviewID, run.Snapshot.ID, query, end, 0)
	}
	return nil
}

func paginateLines(lines []string, offset, maxLines, maxBytes int) (int, int, []string) {
	if offset < 0 {
		offset = 0
	}
	if offset > len(lines) {
		offset = len(lines)
	}
	end := offset
	bytes := 0
	for end < len(lines) && end-offset < maxLines {
		next := len(lines[end]) + 1
		if bytes+next > maxBytes && end > offset {
			break
		}
		bytes += next
		end++
	}
	return offset, end, lines[offset:end]
}

func boolString(value bool) string {
	if value {
		return "1"
	}
	return "0"
}
