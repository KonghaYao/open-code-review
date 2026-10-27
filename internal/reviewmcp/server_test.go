// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package reviewmcp

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/KonghaYao/open-code-review/internal/reviewcore"
)

const (
	testSkillURI          = "skill://project/review/SKILL.md"
	testCodeReviewerURI   = "agent://project/code-reviewer/agent.md"
	testReviewVerifierURI = "agent://project/review-verifier/agent.md"
)

// newReviewServer builds a server over a throwaway repository with one
// uncommitted modification. Git identity and dates are pinned so preparation is
// reproducible and isolated from the host configuration.
func newReviewServer(t *testing.T) *Server {
	t.Helper()
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("GIT_AUTHOR_NAME", "test")
	t.Setenv("GIT_AUTHOR_EMAIL", "test@example.com")
	t.Setenv("GIT_COMMITTER_NAME", "test")
	t.Setenv("GIT_COMMITTER_EMAIL", "test@example.com")
	t.Setenv("GIT_AUTHOR_DATE", "2026-01-01T00:00:00Z")
	t.Setenv("GIT_COMMITTER_DATE", "2026-01-01T00:00:00Z")

	root := t.TempDir()
	runGit(t, root, "init", "-q", "-b", "main")
	writeRepoFile(t, root, "a.txt", "one\ntwo\nthree\n")
	runGit(t, root, "add", "-A")
	runGit(t, root, "commit", "-q", "-m", "base")
	writeRepoFile(t, root, "a.txt", "one\nTWO\nthree\nfour\n")

	server, err := New(Config{Root: root, StateDir: filepath.Join(t.TempDir(), "state")})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return server
}

func runGit(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

func writeRepoFile(t *testing.T, dir, name, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", name, err)
	}
}

func connectClient(t *testing.T, server *Server) *mcp.ClientSession {
	t.Helper()
	ctx := context.Background()
	clientTransport, serverTransport := mcp.NewInMemoryTransports()
	serverSession, err := server.MCP().Connect(ctx, serverTransport, nil)
	if err != nil {
		t.Fatalf("server connect: %v", err)
	}
	t.Cleanup(func() { _ = serverSession.Close() })

	client := mcp.NewClient(&mcp.Implementation{Name: "peri-test", Version: "0.0.0"}, nil)
	if err := mcp.AddSendingCustomMethod[*skillsListParams, *skillsListResult](client, "skills/list"); err != nil {
		t.Fatalf("register skills/list: %v", err)
	}
	if err := mcp.AddSendingCustomMethod[*skillsGetParams, *skillsGetResult](client, "skills/get"); err != nil {
		t.Fatalf("register skills/get: %v", err)
	}
	session, err := client.Connect(ctx, clientTransport, &mcp.ClientSessionOptions{ProtocolVersion: ProtocolVersion})
	if err != nil {
		t.Fatalf("client connect: %v", err)
	}
	t.Cleanup(func() { _ = session.Close() })
	return session
}

func callTool[T any](t *testing.T, ctx context.Context, session *mcp.ClientSession, name string, args map[string]any) T {
	t.Helper()
	result, err := session.CallTool(ctx, &mcp.CallToolParams{Name: name, Arguments: args})
	if err != nil {
		t.Fatalf("call %s: %v", name, err)
	}
	if result.IsError {
		t.Fatalf("tool %s returned an error: %s", name, toolText(result))
	}
	var out T
	if err := json.Unmarshal([]byte(toolText(result)), &out); err != nil {
		t.Fatalf("decode %s result: %v\n%s", name, err, toolText(result))
	}
	return out
}

func toolText(result *mcp.CallToolResult) string {
	for _, content := range result.Content {
		if text, ok := content.(*mcp.TextContent); ok {
			return text.Text
		}
	}
	return ""
}

func structuredCode(result *mcp.CallToolResult) string {
	fields, ok := result.StructuredContent.(map[string]any)
	if !ok {
		return ""
	}
	code, _ := fields["code"].(string)
	return code
}

func TestServerDiscovery(t *testing.T) {
	server := newReviewServer(t)
	session := connectClient(t, server)
	ctx := context.Background()

	init := session.InitializeResult()
	if init.ProtocolVersion != ProtocolVersion {
		t.Fatalf("protocol version = %q, want %q", init.ProtocolVersion, ProtocolVersion)
	}
	if init.Capabilities == nil || init.Capabilities.Extensions == nil {
		t.Fatalf("capabilities = %+v, want an extensions map", init.Capabilities)
	}
	if _, ok := init.Capabilities.Extensions[SkillsExtension]; !ok {
		t.Fatalf("extensions = %v, want %q", init.Capabilities.Extensions, SkillsExtension)
	}

	tools, err := session.ListTools(ctx, &mcp.ListToolsParams{})
	if err != nil {
		t.Fatalf("tools/list: %v", err)
	}
	wantTools := map[string]bool{
		"review_prepare": true,
		"review_context": true,
		"review_status":  true,
		"review_submit":  true,
		"review_verify":  true,
		"review_finish":  true,
	}
	if len(tools.Tools) != len(wantTools) {
		t.Fatalf("tools = %d, want exactly %d", len(tools.Tools), len(wantTools))
	}
	for _, tool := range tools.Tools {
		if !wantTools[tool.Name] {
			t.Fatalf("unexpected tool %q", tool.Name)
		}
		delete(wantTools, tool.Name)
	}
	if len(wantTools) != 0 {
		t.Fatalf("missing tools: %v", wantTools)
	}

	resources, err := session.ListResources(ctx, &mcp.ListResourcesParams{})
	if err != nil {
		t.Fatalf("resources/list: %v", err)
	}
	uris := map[string]bool{}
	for _, resource := range resources.Resources {
		uris[resource.URI] = true
	}
	for _, uri := range []string{testSkillURI, testCodeReviewerURI, testReviewVerifierURI} {
		if !uris[uri] {
			t.Fatalf("resources = %v, missing %q", uris, uri)
		}
	}

	read, err := session.ReadResource(ctx, &mcp.ReadResourceParams{URI: testSkillURI})
	if err != nil {
		t.Fatalf("resources/read: %v", err)
	}
	if len(read.Contents) != 1 {
		t.Fatalf("resource contents = %d, want 1", len(read.Contents))
	}
	if !strings.Contains(read.Contents[0].Text, "# Peri code review") {
		t.Fatalf("SKILL.md does not contain its title:\n%s", read.Contents[0].Text[:min(len(read.Contents[0].Text), 200)])
	}
}

func TestSkillsCustomMethods(t *testing.T) {
	server := newReviewServer(t)
	session := connectClient(t, server)
	ctx := context.Background()

	list, err := mcp.CallCustomMethod[*skillsListParams, *skillsListResult](ctx, session, "skills/list", &skillsListParams{})
	if err != nil {
		t.Fatalf("skills/list: %v", err)
	}
	if len(list.Skills) != 1 {
		t.Fatalf("skills = %+v, want exactly one", list.Skills)
	}
	entry := list.Skills[0]
	if entry.URI != testSkillURI {
		t.Fatalf("skill URI = %q, want %q", entry.URI, testSkillURI)
	}
	if name, _ := entry.Frontmatter["name"].(string); name != "review" {
		t.Fatalf("skill frontmatter name = %v, want review", entry.Frontmatter["name"])
	}
	if description, _ := entry.Frontmatter["description"].(string); strings.TrimSpace(description) == "" {
		t.Fatal("skill frontmatter description is empty")
	}
	if len(entry.Resources) != 1 || entry.Resources[0].URI != testSkillURI {
		t.Fatalf("skill resources = %+v", entry.Resources)
	}
	if !strings.HasPrefix(entry.Resources[0].Digest, "sha256:") {
		t.Fatalf("skill resource digest = %q", entry.Resources[0].Digest)
	}

	get, err := mcp.CallCustomMethod[*skillsGetParams, *skillsGetResult](ctx, session, "skills/get", &skillsGetParams{URI: testSkillURI})
	if err != nil {
		t.Fatalf("skills/get: %v", err)
	}
	if get.Skill.URI != testSkillURI {
		t.Fatalf("skills/get URI = %q, want %q", get.Skill.URI, testSkillURI)
	}

	if _, err := mcp.CallCustomMethod[*skillsGetParams, *skillsGetResult](ctx, session, "skills/get", &skillsGetParams{URI: "skill://project/unknown/SKILL.md"}); err == nil {
		t.Fatal("skills/get must reject an unknown URI")
	}
}

func TestReviewFlowOverProtocol(t *testing.T) {
	server := newReviewServer(t)
	session := connectClient(t, server)
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	prepareArgs := func(key string) map[string]any {
		return map[string]any{
			"input":       map[string]any{"mode": "workspace"},
			"request_key": key,
			"background":  "exercise the protocol end to end",
		}
	}

	prepared := callTool[reviewcore.PrepareResponse](t, ctx, session, "review_prepare", prepareArgs("prepare:test"))
	if prepared.ReviewID == "" {
		t.Fatal("review_id is empty")
	}
	if prepared.Replayed {
		t.Fatal("first prepare must not be a replay")
	}
	if len(prepared.Units) == 0 {
		t.Fatal("prepare returned no units")
	}
	if prepared.Counts.Units != len(prepared.Units) {
		t.Fatalf("units = %d, counts.units = %d; the test assumes one page", len(prepared.Units), prepared.Counts.Units)
	}
	if prepared.RulesDigest == "" || prepared.AssetsDigest == "" {
		t.Fatalf("digests are incomplete: rules=%q assets=%q", prepared.RulesDigest, prepared.AssetsDigest)
	}
	if prepared.Input.Mode != reviewcore.ModeWorkspace {
		t.Fatalf("input mode = %q, want workspace", prepared.Input.Mode)
	}

	replayed := callTool[reviewcore.PrepareResponse](t, ctx, session, "review_prepare", prepareArgs("prepare:test"))
	if !replayed.Replayed || replayed.ReviewID != prepared.ReviewID {
		t.Fatalf("replayed prepare = (%q, %v), want review %q", replayed.ReviewID, replayed.Replayed, prepared.ReviewID)
	}

	for _, unit := range prepared.Units {
		submitted := callTool[reviewcore.SubmitResponse](t, ctx, session, "review_submit", map[string]any{
			"review_id":   prepared.ReviewID,
			"unit_id":     unit.ID,
			"outcome":     reviewcore.UnitReviewed,
			"request_key": "submit:" + prepared.ReviewID + ":" + unit.ID,
		})
		if submitted.Outcome != reviewcore.UnitReviewed || submitted.Unit.Status != reviewcore.UnitReviewed {
			t.Fatalf("unit %s submit = %+v", unit.ID, submitted)
		}
	}

	status := callTool[reviewcore.StatusResponse](t, ctx, session, "review_status", map[string]any{
		"review_id": prepared.ReviewID,
		"section":   "coverage",
	})
	if status.Coverage == nil {
		t.Fatal("status has no coverage section")
	}
	if !status.Coverage.Complete || status.Coverage.Reviewed != status.Coverage.Required {
		t.Fatalf("coverage = %+v, want complete", status.Coverage)
	}

	finished := callTool[reviewcore.FinishResponse](t, ctx, session, "review_finish", map[string]any{
		"review_id":   prepared.ReviewID,
		"intent":      reviewcore.IntentFinalize,
		"request_key": "finish:" + prepared.ReviewID,
	})
	if finished.Status != reviewcore.RunCompleted {
		t.Fatalf("finish status = %q, want %q", finished.Status, reviewcore.RunCompleted)
	}
	wantJSON, wantMarkdown := reviewcore.ReportURIs(prepared.ReviewID)
	if finished.ReportJSONURI != wantJSON || finished.ReportMarkdownURI != wantMarkdown {
		t.Fatalf("report URIs = (%q, %q), want (%q, %q)",
			finished.ReportJSONURI, finished.ReportMarkdownURI, wantJSON, wantMarkdown)
	}
	if len(finished.Gaps) != 0 {
		t.Fatalf("finalize gaps = %#v, want none", finished.Gaps)
	}

	jsonResource, err := session.ReadResource(ctx, &mcp.ReadResourceParams{URI: finished.ReportJSONURI})
	if err != nil {
		t.Fatalf("read report.json: %v", err)
	}
	if len(jsonResource.Contents) != 1 {
		t.Fatalf("report.json contents = %d, want 1", len(jsonResource.Contents))
	}
	reportText := jsonResource.Contents[0].Text
	if !json.Valid([]byte(reportText)) {
		t.Fatalf("report.json is not valid JSON:\n%s", reportText)
	}
	var report reviewcore.Report
	if err := json.Unmarshal([]byte(reportText), &report); err != nil {
		t.Fatalf("decode report.json: %v", err)
	}
	if report.ReviewID != prepared.ReviewID || report.Status != reviewcore.RunCompleted {
		t.Fatalf("report identity = (%q, %q)", report.ReviewID, report.Status)
	}
	if !report.Coverage.Complete {
		t.Fatalf("report coverage = %+v, want complete", report.Coverage)
	}

	markdown, err := session.ReadResource(ctx, &mcp.ReadResourceParams{URI: finished.ReportMarkdownURI})
	if err != nil {
		t.Fatalf("read report.md: %v", err)
	}
	if len(markdown.Contents) != 1 {
		t.Fatalf("report.md contents = %d, want 1", len(markdown.Contents))
	}
	if !strings.Contains(markdown.Contents[0].Text, "# Code review report") {
		t.Fatalf("report.md has no title:\n%s", markdown.Contents[0].Text)
	}
}

func TestToolBusinessErrors(t *testing.T) {
	server := newReviewServer(t)
	session := connectClient(t, server)
	ctx := context.Background()

	t.Run("empty request_key", func(t *testing.T) {
		result, err := session.CallTool(ctx, &mcp.CallToolParams{
			Name: "review_prepare",
			Arguments: map[string]any{
				"input":       map[string]any{"mode": "workspace"},
				"request_key": "",
			},
		})
		if err != nil {
			t.Fatalf("review_prepare: %v", err)
		}
		if !result.IsError {
			t.Fatal("review_prepare accepted an empty request_key")
		}
		if code := structuredCode(result); code != string(reviewcore.CodeInvalidArgument) {
			t.Fatalf("code = %q, want %q (result: %s)", code, reviewcore.CodeInvalidArgument, toolText(result))
		}
	})

	t.Run("omitted request_key", func(t *testing.T) {
		result, err := session.CallTool(ctx, &mcp.CallToolParams{
			Name:      "review_prepare",
			Arguments: map[string]any{"input": map[string]any{"mode": "workspace"}},
		})
		if err != nil {
			t.Fatalf("review_prepare: %v", err)
		}
		// The generated input schema marks request_key as required, so the SDK
		// rejects the call before the service can produce a business code.
		if !result.IsError {
			t.Fatal("review_prepare accepted a missing request_key")
		}
	})

	t.Run("unknown review_id", func(t *testing.T) {
		result, err := session.CallTool(ctx, &mcp.CallToolParams{
			Name: "review_status",
			Arguments: map[string]any{
				"review_id": "rv_0123456789abcdef",
				"section":   "summary",
			},
		})
		if err != nil {
			t.Fatalf("review_status: %v", err)
		}
		if !result.IsError {
			t.Fatal("review_status accepted an unknown review_id")
		}
		if code := structuredCode(result); code != string(reviewcore.CodeRunNotFound) {
			t.Fatalf("code = %q, want %q (result: %s)", code, reviewcore.CodeRunNotFound, toolText(result))
		}
	})
}
