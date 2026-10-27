# peri-code-review

`peri-code-review` is the Model Context Protocol (MCP) server that exposes code
review to Peri. It freezes a Git input, splits it into review units, serves
bounded read-only context, validates finding anchors against the frozen
snapshot, records verdicts, computes coverage and derives the report.

The server does not call a model, does not create agents, does not edit the
repository and does not run shell commands on behalf of a caller. Peri owns the
Skill and Agent execution: the server publishes the Skill and Agent definitions,
and the host decides which roles run and with which tools.

```
Peri host (model calls, agents, approvals)
        |
        |  MCP over stdio (JSON-RPC 2.0)
        v
peri-code-review  --  reviewcore (units, findings, coverage, report)
                  --  reviewrepo (git snapshot, immutable reader)
                  --  reviewstore (run files, request keys, locks)
```

## Requirements

- A Go toolchain satisfying `go.mod` (Go 1.26.9).
- `git` on `PATH`. The server shells out to git for read-only commands.
- A Git work tree. `--repo` may point at any directory inside it; the server
  binds the repository top level reported by `git rev-parse --show-toplevel`.
- A state directory outside the repository. The server refuses to start when
  the state directory is inside the work tree.

No model credentials are needed: this process never talks to a model provider.

## Build

```sh
make build
```

The binary is written to `bin/peri-code-review`. Other useful targets:

| Target | Purpose |
| - | - |
| `make test` | Run the Go tests with `LC_ALL=C`. |
| `make vet` | Run `go vet`. |
| `make check` | License and English checks, formatting, tidy and vet. |
| `make coverage` | Report statement coverage. |
| `make clean` | Remove `bin/` and `coverage.out`. |

## Run

```sh
./bin/peri-code-review serve --repo /absolute/path/to/repository
```

The process speaks newline-delimited JSON-RPC on stdin/stdout and writes all
diagnostics to stderr. Run it as a stdio MCP server; do not run it in a
terminal expecting interactive input.

| Flag | Environment | Default | Meaning |
| - | - | - | - |
| `--repo` | - | current directory | Repository to bind. The git top level becomes the root. |
| `--state-dir` | `PERI_CODE_REVIEW_STATE_DIR` | `os.UserCacheDir()/peri-code-review` | Runs, request-key index, locks and frozen snapshots. Must be outside the repository. |

An explicit `--state-dir` wins over `PERI_CODE_REVIEW_STATE_DIR`, which wins
over the cache default. `./bin/peri-code-review version` prints the embedded
version string. Invalid usage exits with status 2; a startup failure exits with
status 1 and a single `peri-code-review: ...` line on stderr.

The state directory holds `requests.json`, `runs/<review_id>/state.json`,
`locks/` and `snapshots/<snapshot_id>/`. Run directories are created with mode
0700 because they contain repository content.

## Peri configuration

Add one stdio server. Keep the server name `peri-code-review` unless you also
update every place that projects the Agent names.

```json
{
  "mcpServers": {
    "peri-code-review": {
      "command": "/absolute/path/to/bin/peri-code-review",
      "args": [
        "serve",
        "--repo",
        "/absolute/path/to/repository"
      ],
      "env": {
        "PERI_CODE_REVIEW_STATE_DIR": "/absolute/path/to/review-state"
      },
      "system_mcp": true,
      "system_mcp_tools": [
        "review_prepare",
        "review_context",
        "review_status",
        "review_submit",
        "review_verify",
        "review_finish"
      ]
    }
  }
}
```

`system_mcp: true` makes the server a startup dependency of the Peri React
loop, and `system_mcp_tools` lists the exact tool names that must be present at
their original names before the first model turn. Tools not listed there stay
behind the `mcp__<server>__<tool>` prefix. The same configuration is kept in
[`docs/peri-mcp/peri-config.example.json`](docs/peri-mcp/peri-config.example.json).

## Tools

The server exposes exactly six tools.

| Tool | Access | Purpose |
| - | - | - |
| `review_prepare` | write | Freeze a range, commit or workspace into an immutable snapshot, plan review units and return the first page. |
| `review_context` | read | Read a unit with its rules, a diff slice, a file slice, the manifest, a search result or rule groups from the frozen snapshot. |
| `review_status` | read | Read progress: summary, coverage, units, findings, verifications, report or gaps. Safe to poll. |
| `review_submit` | write | Atomically commit one unit outcome and its findings. One invalid finding rejects the batch. |
| `review_verify` | write | Record one independent verdict for a finding with optimistic revision checking. |
| `review_finish` | write | Seal a run: `finalize` requires every required unit and finding to be complete; `close_partial` and `cancel` preserve explicit partial results and gaps. |

Every write takes a stable `request_key`; retries must reuse the key. All
review tool results carry `schema_version` with the value
`peri-code-review/v1`. Business errors set `isError: true` and return a JSON
object with a stable `code` such as `REVISION_CONFLICT` or
`IDEMPOTENCY_CONFLICT`.

## Resources and skills

- `skill://project/review/SKILL.md` describes the review workflow.
- `agent://project/code-reviewer/agent.md` and
  `agent://project/review-verifier/agent.md` define the two review roles.
- `review://runs/{review_id}/report.json` and `report.md` are the report
  templates.
- The `io.modelcontextprotocol/skills` extension provides `skills/list` and
  `skills/get`.

The server negotiates protocol version `2026-07-28` and advertises `tools`,
`resources` and the Skills extension. It does not provide `prompts`, `logging`,
`sampling` or `roots`, and never calls back into the client.

## Documentation

- [`docs/peri-mcp/README.md`](docs/peri-mcp/README.md): build, run, Peri
  configuration and the protocol surface.
- [`docs/peri-mcp/contract.md`](docs/peri-mcp/contract.md): tool inputs and
  outputs, idempotency keys, error codes, run lifecycle, coverage rules,
  resource URIs and the Skills wire shape.
- [`docs/peri-mcp/real-peri-checklist.md`](docs/peri-mcp/real-peri-checklist.md):
  steps and assertions for a joint test against a real Peri installation.
- [`docs/peri-mcp/peri-config.example.json`](docs/peri-mcp/peri-config.example.json):
  the configuration shown above.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) and
[`AGENTS.md`](AGENTS.md). Commit messages are written in English, source files
carry SPDX headers and are English-only.

## License

Apache-2.0. See [`LICENSE`](LICENSE). The review domain code originates from
[`alibaba/open-code-review`](https://github.com/alibaba/open-code-review) and
retains its upstream copyright notices.
