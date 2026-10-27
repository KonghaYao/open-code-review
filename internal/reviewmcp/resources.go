// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package reviewmcp

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/KonghaYao/open-code-review/internal/reviewcore"
)

const reportPrefix = "review://runs/"

func (s *Server) registerResources() {
	skill := s.assets.Skill()
	s.addDocumentResource(skill.URI, skill.Name, skill.Description, skill.Content, skill.MIMEType)
	for _, agent := range s.assets.Agents() {
		s.addDocumentResource(agent.URI, agent.Name, agent.Description, agent.Content, agent.MIMEType)
	}
	s.mcp.AddResourceTemplate(&mcp.ResourceTemplate{
		URITemplate: reportPrefix + "{review_id}/report.json",
		Name:        "review-report-json",
		Description: "Machine-readable report for a sealed or in-progress review.",
		MIMEType:    "application/json",
	}, s.readReport)
	s.mcp.AddResourceTemplate(&mcp.ResourceTemplate{
		URITemplate: reportPrefix + "{review_id}/report.md",
		Name:        "review-report-markdown",
		Description: "Rendered Markdown report for a sealed or in-progress review.",
		MIMEType:    "text/markdown",
	}, s.readReport)
}

func (s *Server) addDocumentResource(uri, name, description, content, mimeType string) {
	s.mcp.AddResource(&mcp.Resource{
		URI:         uri,
		Name:        name,
		Description: description,
		MIMEType:    mimeType,
		Size:        int64(len(content)),
	}, func(_ context.Context, request *mcp.ReadResourceRequest) (*mcp.ReadResourceResult, error) {
		if request.Params.URI != uri {
			return nil, fmt.Errorf("resource %q is not available", request.Params.URI)
		}
		return &mcp.ReadResourceResult{Contents: []*mcp.ResourceContents{{
			URI:      uri,
			MIMEType: mimeType,
			Text:     content,
		}}}, nil
	})
}

func (s *Server) readReport(ctx context.Context, request *mcp.ReadResourceRequest) (*mcp.ReadResourceResult, error) {
	reviewID, format, err := parseReportURI(request.Params.URI)
	if err != nil {
		return nil, err
	}
	report, markdown, err := s.service.Report(ctx, reviewID)
	if err != nil {
		return nil, err
	}
	mimeType := "application/json"
	text := markdown
	if format == "json" {
		data, marshalErr := json.Marshal(report)
		if marshalErr != nil {
			return nil, reviewcore.Errorf(reviewcore.CodeInternal, "encode report: %v", marshalErr)
		}
		text = string(data)
	} else {
		mimeType = "text/markdown"
	}
	return &mcp.ReadResourceResult{Contents: []*mcp.ResourceContents{{
		URI:      request.Params.URI,
		MIMEType: mimeType,
		Text:     text,
	}}}, nil
}

func parseReportURI(uri string) (reviewID, format string, err error) {
	if !strings.HasPrefix(uri, reportPrefix) {
		return "", "", reviewcore.Errorf(reviewcore.CodeInvalidArgument, "unsupported resource URI")
	}
	rest := strings.TrimPrefix(uri, reportPrefix)
	parts := strings.Split(rest, "/")
	if len(parts) != 2 || parts[0] == "" {
		return "", "", reviewcore.Errorf(reviewcore.CodeInvalidArgument, "unsupported report URI")
	}
	switch parts[1] {
	case "report.json":
		format = "json"
	case "report.md":
		format = "markdown"
	default:
		return "", "", reviewcore.Errorf(reviewcore.CodeInvalidArgument, "unsupported report format")
	}
	return parts[0], format, nil
}
