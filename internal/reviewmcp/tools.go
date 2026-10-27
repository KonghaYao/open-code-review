// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package reviewmcp

import (
	"context"
	"encoding/json"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/KonghaYao/open-code-review/internal/reviewcore"
)

func boolPtr(v bool) *bool { return &v }

func readOnlyAnnotations() *mcp.ToolAnnotations {
	return &mcp.ToolAnnotations{
		ReadOnlyHint:    true,
		IdempotentHint:  true,
		DestructiveHint: boolPtr(false),
		OpenWorldHint:   boolPtr(false),
	}
}

func writeAnnotations() *mcp.ToolAnnotations {
	return &mcp.ToolAnnotations{
		ReadOnlyHint:    false,
		IdempotentHint:  true,
		DestructiveHint: boolPtr(false),
		OpenWorldHint:   boolPtr(false),
	}
}

func (s *Server) registerTools() {
	mcp.AddTool(s.mcp, &mcp.Tool{
		Name:        "review_prepare",
		Description: "Freeze a range, commit or workspace into an immutable snapshot, plan review units and return the first page. Pass a stable request_key; resume_from reuses completed units of the same input.",
		Annotations: writeAnnotations(),
	}, s.prepare)
	mcp.AddTool(s.mcp, &mcp.Tool{
		Name:        "review_context",
		Description: "Read bounded context from the frozen snapshot: a unit with its rules, a diff slice, a file slice, the manifest, a search result or rule groups. Never reads the live worktree.",
		Annotations: readOnlyAnnotations(),
	}, s.context)
	mcp.AddTool(s.mcp, &mcp.Tool{
		Name:        "review_status",
		Description: "Read progress: summary, coverage, units, findings, verifications, report or gaps. Read-only and safe to poll.",
		Annotations: readOnlyAnnotations(),
	}, s.status)
	mcp.AddTool(s.mcp, &mcp.Tool{
		Name:        "review_submit",
		Description: "Atomically commit one unit outcome and its findings. One invalid finding rejects the batch. Use a stable request_key per unit.",
		Annotations: writeAnnotations(),
	}, s.submit)
	mcp.AddTool(s.mcp, &mcp.Tool{
		Name:        "review_verify",
		Description: "Record one independent verdict for a finding with optimistic revision checking. Use the finding's current revision as expected_revision.",
		Annotations: writeAnnotations(),
	}, s.verify)
	mcp.AddTool(s.mcp, &mcp.Tool{
		Name:        "review_finish",
		Description: "Seal a run. finalize requires every required unit and finding to be complete; close_partial and cancel preserve explicit partial results and gaps.",
		Annotations: writeAnnotations(),
	}, s.finish)
}

func (s *Server) prepare(ctx context.Context, _ *mcp.CallToolRequest, input reviewcore.PrepareRequest) (*mcp.CallToolResult, any, error) {
	response, err := s.service.Prepare(ctx, input)
	if err != nil {
		return errorResult(err), nil, nil
	}
	return successResult(response), nil, nil
}

func (s *Server) context(ctx context.Context, _ *mcp.CallToolRequest, input reviewcore.ContextRequest) (*mcp.CallToolResult, any, error) {
	response, err := s.service.Context(ctx, input)
	if err != nil {
		return errorResult(err), nil, nil
	}
	return successResult(response), nil, nil
}

func (s *Server) status(ctx context.Context, _ *mcp.CallToolRequest, input reviewcore.StatusRequest) (*mcp.CallToolResult, any, error) {
	response, err := s.service.Status(ctx, input)
	if err != nil {
		return errorResult(err), nil, nil
	}
	return successResult(response), nil, nil
}

func (s *Server) submit(ctx context.Context, _ *mcp.CallToolRequest, input reviewcore.SubmitRequest) (*mcp.CallToolResult, any, error) {
	response, err := s.service.Submit(ctx, input)
	if err != nil {
		return errorResult(err), nil, nil
	}
	return successResult(response), nil, nil
}

func (s *Server) verify(ctx context.Context, _ *mcp.CallToolRequest, input reviewcore.VerifyRequest) (*mcp.CallToolResult, any, error) {
	response, err := s.service.Verify(ctx, input)
	if err != nil {
		return errorResult(err), nil, nil
	}
	return successResult(response), nil, nil
}

func (s *Server) finish(ctx context.Context, _ *mcp.CallToolRequest, input reviewcore.FinishRequest) (*mcp.CallToolResult, any, error) {
	response, err := s.service.Finish(ctx, input)
	if err != nil {
		return errorResult(err), nil, nil
	}
	return successResult(response), nil, nil
}

func successResult(value any) *mcp.CallToolResult {
	data, err := json.Marshal(value)
	if err != nil {
		return errorResult(reviewcore.Errorf(reviewcore.CodeInternal, "encode result: %v", err))
	}
	return &mcp.CallToolResult{
		Content:           []mcp.Content{&mcp.TextContent{Text: string(data)}},
		StructuredContent: value,
	}
}

func errorResult(err error) *mcp.CallToolResult {
	business := reviewcore.AsError(err)
	data, marshalErr := json.Marshal(business)
	if marshalErr != nil {
		data = []byte(`{"code":"INTERNAL","message":"encode error"}`)
	}
	return &mcp.CallToolResult{
		IsError:           true,
		Content:           []mcp.Content{&mcp.TextContent{Text: string(data)}},
		StructuredContent: business,
	}
}
