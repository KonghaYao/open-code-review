// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

// Command peri-code-review serves the review MCP over stdio.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/KonghaYao/open-code-review/internal/reviewmcp"
)

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	switch os.Args[1] {
	case "serve":
		serve(os.Args[2:])
	case "version", "--version", "-version":
		fmt.Println(version)
	default:
		usage()
		os.Exit(2)
	}
}

var version = "0.1.0"

func usage() {
	fmt.Fprintln(os.Stderr, "usage: peri-code-review serve [--repo PATH] [--state-dir PATH]")
}

func serve(args []string) {
	flags := flag.NewFlagSet("serve", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	repo := flags.String("repo", "", "repository to review; defaults to the current directory")
	stateDir := flags.String("state-dir", os.Getenv("PERI_CODE_REVIEW_STATE_DIR"), "state directory outside the repository")
	if err := flags.Parse(args); err != nil {
		os.Exit(2)
	}
	server, err := reviewmcp.New(reviewmcp.Config{
		Root:     *repo,
		StateDir: *stateDir,
		Version:  version,
	})
	if err != nil {
		fmt.Fprintf(os.Stderr, "peri-code-review: %v\n", err)
		os.Exit(1)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := server.Run(ctx); err != nil && !errors.Is(err, context.Canceled) {
		fmt.Fprintf(os.Stderr, "peri-code-review: %v\n", err)
		os.Exit(1)
	}
}
