// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package reviewmcp

import (
	"context"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/KonghaYao/open-code-review/internal/reviewcore"
)

type skillsListParams struct {
	mcp.ParamsBase
	Cursor string `json:"cursor,omitempty"`
}

type skillEntry struct {
	URI         string                     `json:"uri"`
	Frontmatter map[string]any             `json:"frontmatter"`
	Resources   []reviewcore.AssetResource `json:"resources"`
}

type skillsListResult struct {
	mcp.ResultBase
	Skills     []skillEntry `json:"skills"`
	NextCursor string       `json:"nextCursor,omitempty"`
}

type skillsGetParams struct {
	mcp.ParamsBase
	URI string `json:"uri"`
}

type skillsGetResult struct {
	mcp.ResultBase
	Skill skillEntry `json:"skill"`
}

// registerSkills implements the SEP-2640 discovery methods. Peri reads the
// SKILL.md body through resources/read; skills/get only returns metadata.
func (s *Server) registerSkills() {
	if err := mcp.AddReceivingCustomMethod(s.mcp, "skills/list",
		func(_ context.Context, _ *mcp.ServerSession, params *skillsListParams) (*skillsListResult, error) {
			if params != nil && params.Cursor != "" {
				return nil, reviewcore.Errorf(reviewcore.CodeInvalidCursor, "unknown skills cursor")
			}
			return &skillsListResult{Skills: []skillEntry{s.skillEntry()}}, nil
		}); err != nil {
		panic(err)
	}
	if err := mcp.AddReceivingCustomMethod(s.mcp, "skills/get",
		func(_ context.Context, _ *mcp.ServerSession, params *skillsGetParams) (*skillsGetResult, error) {
			skill := s.assets.Skill()
			if params == nil || params.URI != skill.URI {
				return nil, reviewcore.Errorf(reviewcore.CodeInvalidArgument, "unknown skill URI")
			}
			return &skillsGetResult{Skill: s.skillEntry()}, nil
		}); err != nil {
		panic(err)
	}
}

func (s *Server) skillEntry() skillEntry {
	skill := s.assets.Skill()
	return skillEntry{
		URI:         skill.URI,
		Frontmatter: skill.Frontmatter,
		Resources:   append([]reviewcore.AssetResource(nil), skill.Resources...),
	}
}
