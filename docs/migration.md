# Migration from the Go server

This repository has been converted from a Go MCP server to a pure TypeScript npm
package. The Go CLI, rule documents, state store, snapshots and six-tool protocol
are removed. This document maps the old behavior to the new package, records the
intended break, and lists what is still not verified or not implemented.

The protocol itself is documented in [contract.md](contract.md).

## 1. Tool mapping

| Go tool | TypeScript replacement | Notes |
| - | - | - |
| `review_prepare` | `prepare_code_review` | Returns `source`, `reviewKey`, `manifestDigest`, units and exclusions. No `review_id` or snapshot ID. |
| `review_context` | `get_code_review_area` | Returns matched checks and rule IDs only. Source reading moved to the review/verify agents, which read fixed Git objects with host tools. |
| `review_status` | Removed | Coverage, completion and outcome are recomputed by `export_code_review`. There is no server-side run status. |
| `review_submit` | Removed | Review agents return `UnitResult` objects in the Ultracode workflow result. |
| `review_verify` | Removed | Verification agents return `VerificationResult` objects in the workflow result. |
| `review_finish` | `export_code_review` | Reads one completed run, revalidates it and writes JSON/Markdown. There is no seal or report-template resource. |

`review_prepare` request keys and idempotency records are gone. Identity is now
`reviewKey` plus `manifestDigest`; repeated calls with the same fixed Git input,
scope, rule catalog and server version reproduce the same identity.

The old field naming was snake_case (`include_tests`, `review_id`, `unit_id`).
The TypeScript contract uses camelCase JSON fields (`includeTests`, `unitId`)
while keeping snake_case tool names.

## 2. Configuration and state

| Old | New |
| - | - |
| `--repo` (any directory inside the work tree) | `--repo` (repository root; one process per repository) |
| `--state-dir` | Removed |
| `PERI_CODE_REVIEW_STATE_DIR` | Removed |
| `~/.cache/peri-code-review` (runs, locks, snapshots) | Removed; no server-side run directory |
| `state.json`, `requests.json`, `locks/`, `snapshots/` | Removed |
| `review://runs/{id}/report.json|md` templates | Removed; reports are written to `--output-dir` |
| `agent://project/.../agent.md` resources | Removed; review and verification are skills |
| Whole rule catalog / rule docs | Internal `assets/rules/system-rules.json`, reachable only through `get_code_review_area` |
| Go Makefile and Go CI | npm scripts and `.github/workflows/ci.yml` |

New options:

| Option | Default | Meaning |
| - | - | - |
| `--workflow-root` | `<repo>/.claude/workflow-runs` | Read-only source of Ultracode run records. |
| `--output-dir` | `~/.peri/reports/code-review` | Writable report destination. |

The server no longer creates run directories, locks, snapshots, stashes,
commits, worktrees or checkout states. `workspace` mode records a fingerprint
and refuses to continue when the worktree or index changes. It cannot recover
old bytes; for a stable review, commit first and use `commit` or `range`.

## 3. Skills and resources

| Old resource | New resource |
| - | - |
| `skill://project/review/SKILL.md` | `skill://project/review/SKILL.md` (rewritten for the new flow) |
| two `agent://project/.../agent.md` documents | `skill://project/review-code/SKILL.md` and `skill://project/review-verify/SKILL.md` |
| report templates under `review://` | Removed; report rendering is internal |
| no workflow example | `skill://project/review/example.js` |

The main skill still owns orchestration, but now names the two child skills
together with their inputs and return targets. The review and verification roles
are skills loaded with the host `SkillTool`; they use an existing
general-purpose agent type and an explicit tool allowlist, not a published
`agent://` definition. `example.js` is plain JavaScript: it has no
TypeScript-only syntax and passes `node --check`.

`skills/list` and `skills/get` keep the Peri Contract C wire shape: resource
references have only `uri` and `digest`, with no `size`, and digests are
`sha256:` over raw UTF-8 bytes. The SDK's built-in Skills extension is not
attached because it always adds `size`. The server declares the extension
capability itself and registers the two methods.

## 4. Module mapping

| Old Go module | TypeScript module |
| - | - |
| `cmd/peri-code-review` | `src/cli.ts` |
| `internal/gitcmd`, `internal/pathutil` | `src/git/` |
| `internal/reviewrepo` | `src/repository/` (diff, manifest, units, exclusions, workspace fingerprint, source verification) |
| `internal/config/rules`, `internal/config/allowlist` | `assets/rules/` and `src/rules/` |
| `internal/reviewcore` | `src/domain/` and `src/report/` |
| `internal/reviewstore` | Removed; `src/run/` is a read-only Ultracode adapter |
| `internal/reviewassets` | `assets/skills/`, `assets/workflow/` |
| `internal/reviewmcp` | `src/mcp/` |
| Go tests | Vitest suites beside each module in `src/**/*.test.ts` |

The package builds with tsup to `dist/` and resolves assets from the installed
package, not from the current working directory. `npm pack` produces one tarball
with no native code and no install-time download.

## 5. Behavior preserved

- MCP revision `2026-07-28` is advertised explicitly, with 2025 revisions for
  compatibility. stdio is the only transport and stdout carries protocol
  messages only.
- Stable unit IDs (`u_` and `u_cross_` plus a short hash), change IDs (`ch_`),
  400 changed lines per unit slice, one deterministic cross-file unit, and a
  complete manifest that is never truncated.
- Range mode uses `merge-base(from, to)`; commit mode compares the first parent
  or the empty tree; new files read the head side and deleted files read the
  base side; renames keep both paths.
- Rule matching by language, path category, change kind and glob, with a
  generic fallback. Project rules stay at `.opencodereview/rule.json` with the
  same `rules`, `include` and `exclude` fields.
- Secret and dependency-directory exclusions: `include` cannot override a
  secret path, and excluded files never count as reviewed.
- JSON and Markdown are rendered from one validated report model. Coverage uses
  the manifest as the denominator, unresolved or missing stage results become
  gaps, and `0/0` is reported as a null ratio, not 100%.
- Git runs with argument arrays and bounded time and output, never a shell
  string. Reports are written atomically and never overwrite different content.

## 6. Remaining limitations

### Not published or jointly tested

- `0.1.0` has not been published to npm. Use `npm pack` and install the tarball.
  A real-registry install and `npx` start are still to be verified.
- No real Peri joint test has been run. The following still need a host check:
  fixed-version stdio startup and clean exit; discovery of the three tools, three
  skills and example; child skills loadable through `SkillTool`; workflow nodes
  have read-only Git access; `commit`/`range` phases read the same base and head;
  workspace changes are detected; candidate and verification IDs cross stages;
  injected failures produce `partial`/`inconclusive`; exported JSON and Markdown
  remain usable after engine cleanup.
- No tarball smoke test from an unrelated working directory has been recorded.

### Implementation gaps observed in this tree

- `prepare_code_review` currently returns placeholder identity values: the
  server constructs the repository without the rule catalog or skill digests, so
  `rulesDigest` is the fallback `sha256:...no-rules` value, `skillDigests` is
  `{}` and `serverVersion` is `0.0.0`. Because `get_code_review_area` compares
  the received `rulesDigest` with the loaded catalog, the current server answers
  `POLICY_CHANGED`. The repository factory must receive the catalog digest,
  skill digests and package version before this flow is usable end to end.
- Prepared units currently have empty `ruleRefs`, because the repository is
  created without the rule matching hooks. `get_code_review_area` still returns
  matched checks for the units.
- `export_code_review` validates result structure, enums, IDs, identities,
  coverage and candidate/verification relationships, but it does not re-read Git
  to verify each snippet and line range. `GitRepository.verifyLocation` exists
  and is tested, but the exporter does not call it yet.
- `get_code_review_area` accepts a cursor for protocol symmetry but returns all
  requested units in one response and never sets `nextCursor`. Callers should
  send bounded `unitIds` batches.

### Scope limits

- One process is bound to one repository; a tool input cannot switch
  repositories.
- One export reads one run. Merging results from several runs into one complete
  report is not supported.
- `workspace` is mutable input. It is fingerprinted, not frozen; there is no
  snapshot recovery and no automatic stash, commit or checkout.
- The engine may clean old run directories. Export the report before relying on
  a run record as a long-term archive.
- There is no HTTP server, model call, automatic fix, pull request, upload or
  comment.
- Node.js 22 is the package baseline (`engines.node >= 22`); the design baseline
  was Node 24. CI covers both 22 and 24.

### Repository follow-ups outside this change

- The legacy helper scripts `scripts/add-license.sh`, `scripts/verify-license.sh`
  and `scripts/verify-english-only.go` remain in the tree but are no longer
  wired into CI.
- `AGENTS.md` and `CONTRIBUTING.md` still describe the deleted Go layout and
  `make` commands. They are not part of the documentation set owned by this
  migration and must be updated separately.
