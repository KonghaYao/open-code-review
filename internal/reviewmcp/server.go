// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

// Package reviewmcp exposes the review service as a Model Context Protocol
// server. It owns no model calls: skills, agents and the host drive reasoning.
package reviewmcp

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/KonghaYao/open-code-review/internal/reviewassets"
	"github.com/KonghaYao/open-code-review/internal/reviewcore"
	"github.com/KonghaYao/open-code-review/internal/reviewrepo"
	"github.com/KonghaYao/open-code-review/internal/reviewstore"
)

// ServerName is the stable implementation name Peri sees during discovery.
const ServerName = "peri-code-review"

// SkillsExtension is the SEP-2640 capability identifier.
const SkillsExtension = "io.modelcontextprotocol/skills"

// ProtocolVersion is the only protocol this server negotiates.
const ProtocolVersion = "2026-07-28"

// Config wires the MCP server to one repository and one state directory.
type Config struct {
	Root         string
	StateDir     string
	ServerName   string
	Version      string
	MaxFileBytes int
	MaxDiffBytes int
	LockTimeout  time.Duration
	PageSize     int
	MaxPageSize  int
	MaxBodyBytes int
}

// Server is the MCP facade over reviewcore.Service.
type Server struct {
	mcp     *mcp.Server
	service *reviewcore.Service
	assets  *reviewassets.Source
}

// New validates the repository binding, opens the state store and registers
// all tools, resources and custom methods.
func New(config Config) (*Server, error) {
	if config.Root == "" {
		root, err := os.Getwd()
		if err != nil {
			return nil, fmt.Errorf("resolve working directory: %w", err)
		}
		config.Root = root
	}
	if config.StateDir == "" {
		cache, err := os.UserCacheDir()
		if err != nil {
			return nil, fmt.Errorf("resolve state directory: %w", err)
		}
		config.StateDir = filepath.Join(cache, "peri-code-review")
	}
	if config.ServerName == "" {
		config.ServerName = ServerName
	}
	if config.Version == "" {
		config.Version = "dev"
	}
	if config.LockTimeout <= 0 {
		config.LockTimeout = 30 * time.Second
	}

	repo, err := reviewrepo.New(config.Root, config.StateDir, reviewrepo.Options{
		MaxFileBytes: config.MaxFileBytes,
		MaxDiffBytes: config.MaxDiffBytes,
	})
	if err != nil {
		return nil, fmt.Errorf("bind repository: %w", err)
	}
	store, err := reviewstore.New(config.StateDir, reviewstore.Options{LockTimeout: config.LockTimeout})
	if err != nil {
		return nil, fmt.Errorf("open state store: %w", err)
	}
	assets, err := reviewassets.New()
	if err != nil {
		return nil, fmt.Errorf("load assets: %w", err)
	}
	service, err := reviewcore.NewService(reviewcore.Config{
		Repo:            repo,
		Store:           store,
		Assets:          assets,
		DefaultPageSize: config.PageSize,
		MaxPageSize:     config.MaxPageSize,
		MaxBodyBytes:    config.MaxBodyBytes,
	})
	if err != nil {
		return nil, err
	}

	capabilities := &mcp.ServerCapabilities{}
	capabilities.AddExtension(SkillsExtension, map[string]any{})
	server := &Server{
		service: service,
		assets:  assets,
		mcp: mcp.NewServer(&mcp.Implementation{
			Name:    config.ServerName,
			Title:   "Peri code review",
			Version: config.Version,
		}, &mcp.ServerOptions{
			Capabilities:              capabilities,
			SupportedProtocolVersions: []string{ProtocolVersion},
			Instructions:              instructions,
		}),
	}
	server.registerTools()
	server.registerResources()
	server.registerSkills()
	return server, nil
}

// MCP exposes the underlying SDK server for in-memory tests and embedding.
func (s *Server) MCP() *mcp.Server { return s.mcp }

// Run serves newline-delimited JSON-RPC over stdin/stdout. All diagnostics go
// through the SDK logger, which writes to stderr.
func (s *Server) Run(ctx context.Context) error {
	return s.mcp.Run(ctx, &mcp.StdioTransport{})
}

const instructions = `This server reviews a frozen Git snapshot and never edits the repository.
Call review_prepare first, then review_context per unit, review_submit once per
unit, review_verify per finding, and review_finish last. Read the published
skill at skill://project/review/SKILL.md and the agent definitions under
resources/list before starting.`
