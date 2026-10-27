# peri-code-review MCP server

`peri-code-review` is the Model Context Protocol server that exposes this
repository's review domain to Peri. It freezes a Git input, splits it into
review units, serves bounded read-only context, validates finding anchors from
the frozen snapshot, records verdicts, computes coverage and derives the
report.

The server does not call a model, does not create agents, does not edit the
repository and does not run shell commands on behalf of a caller. Peri owns the
Skill and Agent execution: the server publishes the Skill and Agent
definitions, and the host decides which roles run and with which tools.

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

- A Go toolchain satisfying `go.mod` in this tree (currently Go 1.26.9).
  `GOTOOLCHAIN=local` with an older toolchain fails before compiling.
- `git` on `PATH`. The server shells out to git for read-only commands.
- A Git work tree. `--repo` may point at any directory inside it; the server
  binds the repository top level reported by `git rev-parse --show-toplevel`.
- A state directory outside the repository. The server refuses to start when
  the state directory is inside the work tree.

## Build

```sh
make build
```

The binary is written to `bin/peri-code-review`. `make test`, `make vet` and
`make check` run the test suite and the repository checks.

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
over the cache default. The cache default resolves to
`~/.cache/peri-code-review` on Linux, `~/Library/Caches/peri-code-review` on
macOS and `%LocalAppData%\peri-code-review` on Windows.

`./bin/peri-code-review version` prints the embedded version string.
Invalid usage exits with status 2; a startup failure (bad repository, state
directory inside the repository, unreadable assets) exits with status 1 and a
single `peri-code-review: ...` line on stderr.

### State directory layout

```
<state-dir>/
  requests.json                     request_key index for prepare
  runs/<review_id>/state.json       one run: units, findings, verdicts, seal
  locks/                            per-run and index lock files
  snapshots/<snapshot_id>/          frozen snapshot metadata and new-side copies
```

Run directories are created with mode 0700 because they contain repository
content. The state directory is validated at startup: a path inside the
repository is rejected with `INVALID_ARGUMENT`, because a snapshot under the
work tree would both make the review input mutable and leak frozen copies into
`git status`.

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

The same document is kept in [peri-config.example.json](peri-config.example.json).

Notes:

- `system_mcp: true` makes the server a startup dependency of the React loop,
  and `system_mcp_tools` lists the exact tool names that must be present at
  their original names before the first model turn. This is the current Peri
  schema: `system_mcp` is a boolean per server entry, not a list of server
  names. Tools not listed there stay behind the `mcp__<server>__<tool>` prefix.
- Agent definitions are projected from this server, so with the name above the
  roles appear as `mcp__peri-code-review__code-reviewer` and
  `mcp__peri-code-review__review-verifier`. Confirm the actual names in the
  host instead of hard-coding them in prompts.
- Every absolute path above is specific to one machine. Replace them per
  installation, keep them out of shared configuration and do not commit a file
  containing another host's paths. `PERI_CODE_REVIEW_STATE_DIR` may also be set
  in the parent environment instead of the `env` block; the `env` block keeps
  the server self-contained.
- `--state-dir` in `args` is equivalent to the environment variable. Use one of
  them, not both, so the effective path is obvious.

## Protocol surface

| Item | Value |
| - | - |
| Transport | stdio, newline-delimited JSON-RPC 2.0 |
| Protocol version | `2026-07-28` only |
| Discovery | `server/discover` (SEP-2575), provided by the Go MCP SDK |
| Tools | `review_prepare`, `review_context`, `review_status`, `review_submit`, `review_verify`, `review_finish` |
| Resources | `skill://project/review/SKILL.md`, two `agent://project/.../agent.md` documents, and the `review://runs/{review_id}/report.json|md` templates |
| Extension | `io.modelcontextprotocol/skills` with `skills/list` and `skills/get` |
| Server info | name `peri-code-review`, title `Peri code review`, version `0.1.0` |

The server advertises exactly one protocol version, so a client that only
implements an older `initialize` handshake is rejected rather than silently
downgraded. `server/discover` returns the server info, the `tools` and
`resources` capabilities, and the Skills extension declaration. Stdout carries
protocol messages only.

## Documentation map

- [contract.md](contract.md): tool inputs and outputs, idempotency keys, error
  codes, run lifecycle, coverage rules, resource URIs and the Skills wire shape.
- [real-peri-checklist.md](real-peri-checklist.md): steps and assertions for a
  joint test against a real Peri installation, plus troubleshooting.
- [peri-config.example.json](peri-config.example.json): the configuration shown
  above.
