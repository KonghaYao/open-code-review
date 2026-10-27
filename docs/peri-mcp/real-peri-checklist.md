# Real Peri joint-test checklist

This checklist is for validating `peri-code-review` against a real Peri
installation. It records steps and assertions only; every item starts
unchecked. A simulated MCP client passing these steps is not evidence that Peri
ran the roles; only the host's own output counts.

Use a disposable repository with a branch, a commit and one modified file.

## 1. Build

- [ ] Run `make build-peri-mcp` and confirm it writes `bin/peri-code-review`.
- [ ] Run `./bin/peri-code-review version` and confirm it prints a version
  string.
- [ ] Run `./bin/peri-code-review` with no arguments and confirm it prints
  `usage: peri-code-review serve [--repo PATH] [--state-dir PATH]` to stderr and
  exits with status 2.

`make build` also builds this binary, followed by the original
`dist/opencodereview`. Building only the MCP server is enough for this
checklist.

## 2. Configure Peri

- [ ] Copy the server block from [README.md](README.md) or
  [peri-config.example.json](peri-config.example.json) into the Peri MCP
  configuration used on this machine.
- [ ] Replace `command`, `--repo` and `PERI_CODE_REVIEW_STATE_DIR` with real
  absolute paths for this host. The state directory must be outside the test
  repository and must not exist inside any other repository either.
- [ ] Keep `system_mcp` and the six names in `system_mcp_tools` exactly as
  written.
- [ ] Restart Peri so the stdio server is relaunched and the startup gate runs
  again.

## 3. Start and discover

- [ ] Confirm Peri reports the server as connected and ready. A startup failure
  appears in Peri's MCP status, not as a tool result.
- [ ] Confirm the state directory now exists and contains `snapshots/` and
  `locks/`, created by the server process.
- [ ] Send `server/discover` with empty params from a client that negotiates
  `2026-07-28`. Assert:
  - [ ] `serverInfo.name` is `peri-code-review`;
  - [ ] the negotiated protocol version is `2026-07-28`;
  - [ ] capabilities contain `tools` and `resources`;
  - [ ] capabilities contain
    `extensions["io.modelcontextprotocol/skills"]` with an object value;
  - [ ] the instructions mention reading the Skill and agents before starting.

A client that only implements the older `initialize` handshake is rejected on
purpose; there is no downgrade path.

## 4. Tool surface

- [ ] Call `tools/list`. Assert exactly six review tools:
  `review_prepare`, `review_context`, `review_status`, `review_submit`,
  `review_verify`, `review_finish`.
- [ ] Assert the four write tools are not marked read-only and the two read
  tools (`review_context`, `review_status`) are.
- [ ] Assert each tool has an input schema derived from the Go request structs;
  `request_key` is required on every write tool.
- [ ] Confirm the host exposes the six names at their original names because
  they are listed in `system_mcp_tools`, and that any other tool from this
  server (none today) would keep the `mcp__<server>__<tool>` prefix.

## 5. Skills and documents

- [ ] Call `skills/list`. Assert one entry with URI
  `skill://project/review/SKILL.md`.
- [ ] Assert the entry's `frontmatter.name` is `review` and
  `frontmatter.description` is a non-empty string.
- [ ] Assert `resources[]` contains the SKILL.md URI itself and each entry has
  a `digest` of the form `sha256:` plus 64 lowercase hex characters.
- [ ] Call `skills/get` with that exact URI and assert the entry is identical to
  the list entry.
- [ ] Call `skills/get` with `skill://review/SKILL.md` and assert
  `INVALID_ARGUMENT`, because the second segment would be a scope, not a name.
- [ ] Read the body with `resources/read` for `skill://project/review/SKILL.md`.
  Assert the returned text starts with the YAML frontmatter and that its
  SHA-256 equals the declared digest. Compute the digest over the exact bytes
  returned, not over a re-encoded copy.
- [ ] Call `resources/list`. Assert three documents:
  `skill://project/review/SKILL.md`,
  `agent://project/code-reviewer/agent.md`,
  `agent://project/review-verifier/agent.md`.
- [ ] Read both agent documents and assert `tools` and `model: inherit` are
  present in their frontmatter.
- [ ] Assert the host's agent catalog projects them as
  `mcp__peri-code-review__code-reviewer` and
  `mcp__peri-code-review__review-verifier`. If the server was configured under
  another name, the names change accordingly; read them from the host rather
  than assuming this pair.
- [ ] If `skills/list` returns method-not-found while the extension is
  advertised, check that `internal/reviewmcp/server.go` calls
  `registerSkills()` from `New`; the handlers in `internal/reviewmcp/skills.go`
  are inert until they are registered.

## 6. Load the skill and activate roles

- [ ] Invoke the published skill from the host. Assert the host loads the
  SKILL.md body rather than only the metadata.
- [ ] Confirm the host requires its normal approval before creating a remote
  agent instance; the server cannot grant tool permissions by itself.
- [ ] Start a code-reviewer role and confirm it can see `review_context` and
  `review_submit` but not `review_verify` or `review_finish`.
- [ ] Start a review-verifier role and confirm it can see `review_context`,
  `review_status` and `review_verify` but not `review_submit` or
  `review_finish`.

## 7. Workspace review flow

Run this sequence with the test repository visibly modified.

- [ ] `review_prepare` with
  `{"input":{"mode":"workspace"},"background":"joint test","request_key":"jt-prepare-1"}`.
  Assert `status` is `active`, `snapshot.mode` is `workspace`, and the response
  contains `review_id`, `snapshot.snapshot_id`, counts and at least one unit.
- [ ] Record the `review_id`, `snapshot.snapshot_id`, every `unit_id` and the
  current content of one changed file.
- [ ] `review_context` with `{"review_id":"<rv>","kind":"unit","unit_id":"<u>"}`
  and assert the diff matches the snapshot, not any later edit.
- [ ] `review_context` with `kind: "search"` for a symbol you know exists in the
  snapshot and assert hits carry repository-relative paths and digests.
- [ ] `review_submit` the unit with a fresh `request_key` and a finding whose
  `location.path` belongs to a different file and assert `PATH_OUT_OF_SCOPE`;
  assert the unit is still `pending` in `review_status`.
- [ ] `review_submit` the unit with a fresh `request_key` and a finding whose
  `location.snippet` is empty and assert `INVALID_ANCHOR`; the unit must remain
  `pending`.
- [ ] `review_submit` the unit once with two findings: one with a real
  location and a distinctive snippet, one whose snippet does not exist. Assert
  the first has `located: true` and `revision: 1`, and the second is accepted
  with `located: false` and a non-empty `locate_note`. Record both
  `finding_id` values.
- [ ] Assert the unit is now `reviewed` and that `review_status`
  (`section: "findings"`) lists both findings.
- [ ] `review_verify` the located finding with `expected_revision: 1` and a
  rationale. Assert `verification.verdict` and that `finding.revision` becomes
  2.
- [ ] `review_verify` the unlocated finding with `expected_revision: 1`,
  `verdict: "unresolved"` and a rationale explaining the missing evidence.
- [ ] Repeat the first verify request with the same key and assert
  `replayed: true` and no second verification in `review_status`.
- [ ] Call verify again on the located finding with `expected_revision: 1` and
  a new key and assert `REVISION_CONFLICT` with
  `details.current_revision = 2`.
- [ ] `review_status` with `section: "coverage"` and assert every unit is in the
  denominator and `reviewed + skipped + failed + pending` equals `required`.
- [ ] `review_finish` with `{"intent":"finalize","request_key":"jt-finish-1"}`
  while units are still pending and assert `REVIEW_INCOMPLETE` with a non-empty
  gap list.
- [ ] Submit the remaining units, verify any remaining findings, then finalize
  and assert `status: "completed"`, `coverage.complete: true` and both report
  URIs.
- [ ] Attempt another `review_submit` with a new key and assert `RUN_SEALED`.

## 8. Reports

- [ ] Read `review://runs/<rv>/report.json` and assert `review_id`, `status`,
  `coverage`, `findings`, `verifications` and `excluded` are present.
- [ ] Read `review://runs/<rv>/report.md` and assert it prints status and
  coverage before findings.
- [ ] Assert both URIs from `review_finish` are exactly the URIs you read.
- [ ] Read a report URI for a nonexistent `rv_...` id and assert
  `RUN_NOT_FOUND`.

## 9. Snapshot immutability and idempotency

- [ ] After prepare, append a line to a file that the snapshot contains, then
  call `review_context` with `kind: "file"` for that path. Assert the content is
  the frozen version, with no appended line.
- [ ] Add a new uncommitted file after prepare and assert a `kind: "search"`
  does not find it.
- [ ] Call `review_prepare` again with the exact same body and key. Assert the
  same `review_id` and `replayed: true`.
- [ ] Call `review_prepare` with the same key but a different `background` and
  assert `IDEMPOTENCY_CONFLICT`.
- [ ] While a `workspace` prepare is running, modify a tracked file in the
  worktree. Assert the call returns `INPUT_CHANGED` and no new run appears in
  `review_status`.
- [ ] With the worktree stable, prepare a second workspace run and confirm it
  succeeds.

## 10. Security assertions

- [ ] Add a file named `.env.local` with fake content and a `.pem` file to the
  worktree. Assert both appear in `excluded` with reason `secret_path`, and
  that `review_context` with `kind: "file"` for either returns `SECRET_PATH`.
- [ ] Search for a string that only exists in `.env.local` and assert there are
  no matches.
- [ ] Create a finding that cites `.env.local` and assert `SECRET_PATH`.
- [ ] Put a change under `node_modules/` and assert it is excluded with reason
  `provider_directory` unless explicitly included in `scope.include`.
- [ ] Confirm no tool result or error message contains the absolute repository
  path or the absolute state directory path.
- [ ] Confirm a state directory placed inside the repository makes startup fail
  with `state directory must be outside the repository`.

## 11. Troubleshooting

| Symptom | Likely cause | Action |
| - | - | - |
| Start fails with `state directory must be outside the repository` | `PERI_CODE_REVIEW_STATE_DIR` or `--state-dir` resolves inside the git work tree, including through a symlink. | Move it outside the repository. Do not point it at `.peri/`, `.cache/` or any directory committed with the project. |
| `go: go.mod requires go >= 1.26.9 (running go 1.23.4; GOTOOLCHAIN=local)` | The local toolchain is older than `go.mod` and toolchain download is disabled. | Install the required Go version, or unset `GOTOOLCHAIN=local` so Go can fetch the declared toolchain. Check `go version` in the same shell Peri uses. |
| `GIT_FAILURE` mentioning `exec: "git"` or an empty top level | `git` is missing from the server's `PATH`, or `--repo` is not inside a work tree. | Run `git --version` under the same environment. Pass an absolute `--repo` inside the work tree. |
| `INVALID_ARGUMENT: unknown skill URI` from `skills/get` | URI differs in scheme, scope, name, file name or case. | Use exactly `skill://project/review/SKILL.md`. `skill://review/SKILL.md` has no scope and is invalid. |
| `skills/list` returns method-not-found | The running server predates the SEP-2640 registration, or the host connected to another binary. | Rebuild `peri-code-review`, confirm `registerSkills()` is called during server construction in `internal/reviewmcp/server.go`, and restart Peri. |
| Tool call fails with a protocol-version error | The client did not negotiate `2026-07-28`. | Use a client with SEP-2575 `server/discover` support; the server advertises no other version. |
| `INPUT_CHANGED` during workspace prepare | The worktree changed between the two fingerprint passes, including untracked files, mode changes or a check running `git status`. | Pause editors, hooks and build watchers, then retry with the same key. A retry with a different body is an idempotency conflict, so use the same body or a new key. |
| `REVISION_CONFLICT` from `review_verify` | `expected_revision` is stale, usually because another verifier already recorded a verdict. | Read the finding again from `review_status` (`section: "findings"`), use its current `revision`, and send a new `request_key`. |
| `IDEMPOTENCY_CONFLICT` | The same `request_key` was used with a different canonical body. | Reuse a key only for a byte-equivalent logical operation; pick a new key for a new operation. |
| `RUN_SEALED` on a write | The run is already `completed`, `partial` or `cancelled`. | Read the report, then start a new run or use `resume_from` to continue unfinished work. |
| `SNAPSHOT_MISSING` on resume or context | The state directory was moved, cleaned or mounted on a different host. | Snapshots are not reconstructed from the worktree. Start a new review. |
| Agents are not in the host catalog | The server is not connected, the documents are not listed under `resources/list`, or the host has not refreshed its catalog. | Check the connection status, read both `agent://` documents, restart Peri, and re-approve the agent if the host asks. |
| Report URI returns `INVALID_ARGUMENT` | The id is not a `rv_...` review id, or the suffix is not exactly `report.json` / `report.md`. | Use the URIs returned by `review_finish`. |
| `EXECUTION_TIMEOUT` | Another process holds the run or index lock for more than 30 seconds. | Mutations take cross-process file locks, so a stuck holder blocks writes. Stop the competing process, then retry with the same key. |

## 12. Sign-off

- [ ] All six tools are visible to the host under the names in
  `system_mcp_tools`.
- [ ] The Skills extension is declared and the SKILL.md digest matches the
  served body.
- [ ] Both agent definitions are projected and can be activated after approval.
- [ ] A workspace review reaches a terminal status through submit, verify and
  finish.
- [ ] Both report formats are readable through their resource URIs.
- [ ] Snapshot reads ignore later worktree changes.
- [ ] Duplicate request keys replay instead of duplicating work.
- [ ] No secret content or internal absolute path appears in any result.
