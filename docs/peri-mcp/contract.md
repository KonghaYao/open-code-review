# peri-code-review protocol contract

This document describes the observable contract of the `peri-code-review` MCP
server as implemented in this tree. Field names match the JSON that crosses the
wire. Implementation references point at the packages that own each rule.

- Transport and MCP surface: `internal/reviewmcp/`
- Tool business rules: `internal/reviewcore/`
- Snapshot and Git binding: `internal/reviewrepo/`
- Run persistence: `internal/reviewstore/`

## 1. Wire basics

The server speaks JSON-RPC 2.0 over stdio, one JSON message per line. Stdout
carries protocol messages only; logs and startup errors go to stderr.

The only negotiated protocol version is `2026-07-28`. The Go MCP SDK answers
`server/discover` (SEP-2575) with the server info, capabilities and
instructions, and the client learns the supported versions there. There is no
downgrade path to the older `initialize` handshake.

Advertised capabilities:

| Capability | Content |
| - | - |
| `tools` | All six review tools, list-changed enabled |
| `resources` | Static Skill and Agent documents plus two report templates, list-changed enabled |
| `extensions["io.modelcontextprotocol/skills"]` | Empty settings object; declares SEP-2640 Skills support |

There is no `prompts`, `logging`, `sampling` or `roots` capability. The server
never calls back into the client.

### Result envelope

Every tool call returns MCP `content` with one `text` item containing the JSON
encoding of the result, and the same object in `structuredContent`. Success and
business errors therefore share a shape that a client can parse without
inspecting prose.

A business error returns `isError: true` and a JSON object:

```json
{
  "code": "REVISION_CONFLICT",
  "message": "finding revision is 3, expected 2",
  "details": { "current_revision": 3 }
}
```

`code` is stable and is the field to branch on. `message` is human-readable and
may change. `details` is optional and, when present, is small and free of
repository paths or credentials.

Every review tool result carries `schema_version` with the value
`peri-code-review/v1`. The Skills methods do not carry it.

### Identifiers

| Identifier | Shape | Producer |
| - | - | - |
| `review_id` | `rv_` + 32 lowercase hex characters | `review_prepare` |
| `snapshot_id` | `snap_` + 32 lowercase hex characters, derived from frozen content | `review_prepare` |
| `unit_id` | `u_` + 16 lowercase hex characters; cross-file unit is `u_cross_` + 16 | `review_prepare` |
| `finding_id` | `fnd_` + lowercase hex characters | `review_submit` |
| `verification_id` | `ver_` + 32 lowercase hex characters | `review_verify` |
| `change_id` | `ch_` + 16 lowercase hex characters, hashed from source, status and both paths | `review_prepare` |

A `review_id` is a business identity, not a credential. The server does not
authenticate callers; the host decides who may start a connection.

### Idempotency keys

Every write takes a `request_key`:

- required, non-empty, at most 200 bytes;
- must not contain NUL, CR, LF or TAB;
- one key identifies one logical operation, so a retry after a lost response
  must reuse the key;
- the server hashes the canonical JSON of the operation and stores
  `key -> hash`;
- same key plus the same hash replays the stored outcome and sets
  `replayed: true`;
- same key plus a different hash returns `IDEMPOTENCY_CONFLICT` and changes
  nothing.

| Tool | Canonical body hashed with the key |
| - | - |
| `review_prepare` | `input`, normalized `scope`, `background`, `resume_from` |
| `review_submit` | `review_id`, `unit_id`, `outcome`, `reason`, `findings` |
| `review_verify` | `review_id`, `finding_id`, `verdict`, `rationale`, `evidence`, `expected_revision` |
| `review_finish` | `review_id`, `intent`, `reason` |

Prepare keys are deduplicated in a state-wide index (`requests.json`) because a
prepare call has no run id yet. Submit, verify and finish keys are recorded on
the run they mutate. Once a key is committed it is bound to that body: reusing
it with a different body is a conflict, never a new request. A request that
failed validation is not recorded, so its key is still free.

`review_context` and `review_status` do not take a key: they are read-only.

## 2. review_prepare

Freezes one input, resolves rules and assets, plans review units and returns
the first page of units. This is the only tool that creates a run.

### Input

| Field | Type | Required | Notes |
| - | - | - | - |
| `input` | object | one of `input` or `resume_from` | Exactly one mode inside. |
| `input.mode` | string | yes | `range`, `commit` or `workspace`. |
| `input.from`, `input.to` | string | `range` | Git refs. Resolved to commits before diffing. |
| `input.commit` | string | `commit` | Git ref. |
| `scope` | object | no | Omitted means tests and deleted-file impact are included. |
| `scope.include_tests` | boolean | no | Default `true`. |
| `scope.include_deleted` | boolean | no | Default `true`. |
| `scope.include` | string[] | no | `doublestar` globs, `/` separators. Explicit includes also override provider-directory and project-filter exclusion. |
| `scope.exclude` | string[] | no | `doublestar` globs. Applied unless the path is explicitly included. |
| `background` | string | no | Trimmed caller intent. Stored on the run and echoed into the report. |
| `request_key` | string | yes | See section 1. |
| `resume_from` | string | no | A previous `review_id` whose snapshot should be reused. |

Input modes:

| Mode | Base | Head | Notes |
| - | - | - | - |
| `range` | merge-base of `from` and `to` | `to` | Both refs must resolve to commits. `commit` must not be set. |
| `commit` | First parent of `commit` | `commit` | A root commit compares against git's empty tree. Merge commits use the first parent. |
| `workspace` | `HEAD` (or the index for an unborn branch) | The captured worktree | Includes staged, unstaged and readable untracked files. `from`, `to` and `commit` must be unset. |

Refs must not start with `-`, must not contain NUL, CR or LF, and must be at
most 512 bytes. They are passed to git as separate arguments, never through a
shell.

### Output

| Field | Type | Notes |
| - | - | - |
| `schema_version` | string | `peri-code-review/v1`. |
| `review_id` | string | New run, or the stored run on replay. |
| `parent_review_id` | string | Present only for a resumed run. |
| `status` | string | `active`. |
| `snapshot` | object | `snapshot_id`, `mode`, `base_sha`, `head_sha`, `merge_base_sha`, `input_digest`, `change_count`, `file_count`. |
| `input` | object | Normalized `mode`, `from`, `to`, `commit`. |
| `scope` | object | Normalized `include_tests`, `include_deleted`, `include`, `exclude`. |
| `background` | string | Trimmed caller intent. |
| `rules_digest` | string | Digest of the rule pack resolved from the same snapshot. |
| `assets_digest` | string | Digest of the published Skill and Agent set. |
| `counts` | object | `changes`, `units`, `required_units`, `cross_file_units`, `excluded`, `findings`, `verifications`. |
| `units` | array | First page of `UnitSummary` objects. |
| `next_cursor` | string | Present when more units exist; pass it to `review_status` with `section: "units"`. |
| `excluded` | array | First page of exclusion entries with `path`, `side`, `reason`, `source`. |
| `excluded_count` | integer | Total exclusions, not just the returned page. |
| `replayed` | boolean | `true` when an existing run was returned. |

`UnitSummary` fields: `unit_id`, `kind` (`file` or `cross_file`), `change_ids`,
`paths`, `side` (`old` or `new`), `start_line`, `end_line`, `rule_refs` (array
of `source` and `pattern`), `status`, `reason`, `reused`.

### Semantics

1. Normalize and validate the input and scope.
2. If `resume_from` is set, load the parent run and decide whether reuse is
   allowed. Reuse requires the same normalized input, the same scope (unless
   the caller omitted scope, in which case the parent scope is inherited), and
   the same `assets_digest`. A parent without a snapshot fails with
   `SNAPSHOT_MISSING`.
3. Otherwise freeze a new snapshot from git objects and copy reviewable
   new-side content under the state directory.
4. Resolve the project rule pack from the same snapshot and record
   `rules_digest`.
5. Plan units: one or more file units per change plus one `cross_file` unit
   covering all included paths. File units are sliced on hunk boundaries at
   most 400 changed diff lines per unit.
6. Persist the run and its request key atomically, then return page one.

`workspace` preparation re-reads a worktree fingerprint (git status plus a
content digest per changed path) after collection. Any difference returns
`INPUT_CHANGED` and creates no run. Secret paths contribute only size and
mtime to that fingerprint, so their bytes are never read.

Resume rules:

- Completed (`reviewed`) units are copied with `reused: true` and
  `reused_from` set to the parent id; their findings and verifications are
  copied too.
- Pending, skipped and failed units are reset to `pending` with no submission
  metadata.
- Skipped and failed units are not reused: only a reviewed unit proves work was
  done.
- An incompatible request prepares a fresh snapshot and a fresh run. The server
  never falls back to the live worktree for a missing snapshot.

The first page holds 20 units (the service default; `review_prepare` has no
`limit` field). To enumerate the remaining units, use `review_status`
(`section: "units"`) or `review_context` (`kind: "manifest"`); each of those
cursors is bound to its own query and is rejected with `INVALID_CURSOR`
elsewhere.

### Errors

`INVALID_INPUT`, `INVALID_ARGUMENT`, `IDEMPOTENCY_CONFLICT`, `SNAPSHOT_MISSING`,
`INPUT_CHANGED`, `GIT_FAILURE`, `PREPARATION_FAILED`, `EXECUTION_TIMEOUT`,
`STATE_CORRUPT`, `STATE_VERSION_UNSUPPORTED`, `INTERNAL`.

## 3. review_context

Reads bounded context from the frozen snapshot. It never reads the live
worktree and never accepts a repository path or a ref.

### Input

| Field | Type | Required | Notes |
| - | - | - | - |
| `review_id` | string | yes | Must match `rv_...`. |
| `kind` | string | yes (schema) | `unit`, `diff`, `file`, `manifest`, `search` or `rules`. An empty value falls back to `manifest` inside the service. |
| `unit_id` | string | `kind=unit` | Also accepted by `diff` and `rules`. |
| `change_id` | string | `kind=diff` (with `unit_id`) | One of `unit_id` or `change_id` is required for `diff`. |
| `path` | string | `kind=file`, or `kind=rules` | Repository-relative path. |
| `side` | string | no | `old` or `new`; defaults to `new`. |
| `start_line` | integer | no | 1-based first line for `kind=file`; defaults to 1 or continues from the cursor. |
| `end_line` | integer | no | Caps the returned range with `start_line`; `limit` still applies. Must not be before `start_line`. |
| `limit` | integer | no | Page size; clamped per kind (see limits). |
| `cursor` | string | no | Opaque, bound to review, snapshot and query. |
| `query` | string | `kind=search` | At most 500 bytes. |
| `case_sensitive` | boolean | no | Default `false`. |
| `regex` | boolean | no | Default `false`. |
| `path_prefix` | string | no | Restricts search to a path prefix. |

### Input combinations

| Kind | Requires | Page size | Result key |
| - | - | - | - |
| `unit` | `unit_id` | Whole unit diff must fit the body limit | `unit` |
| `diff` | `unit_id` or `change_id` | 2000 lines or the body limit, whichever comes first | `diff` |
| `file` | `path`, optional `side`, `start_line`, `limit` | Default 200 lines, max 2000, and the body limit | `file` |
| `manifest` | nothing | Default 20, max 200 | `manifest` |
| `search` | `query` | Default 20, max 100 | `search` |
| `rules` | `unit_id` or `path` | Default 5, max 20 rule groups | `rules` |

### Output

Common fields: `schema_version`, `review_id`, `snapshot_id`, `kind`,
`next_cursor`.

| Kind | Payload |
| - | - |
| `unit` | `unit`: `UnitSummary` plus `diff`, `diff_bytes` and `rules` (array of `RuleGroup`). |
| `diff` | `diff`: `change_id`, `unit_id`, `path`, `content`, `line_start`, `line_end`, `total_lines`, `bytes`. |
| `file` | `file`: `path`, `side`, `content`, `line_start`, `line_end`, `total_lines`, `bytes`, `digest`, optional `binary`. |
| `manifest` | `manifest`: `changes` (array of `ChangeSummary`), `units` (array of `UnitSummary`), `total_changes`, `total_units`. |
| `search` | `search`: `query`, `matches` (array of `path`, `side`, `line`, `end_line`, `excerpt`, `digest`), `total`, `scanned_files`, `skipped_files`. |
| `rules` | `rules`: array of `RuleGroup` (`source`, `pattern`, `text`, `files`). |

`ChangeSummary` fields: `change_id`, `status`, `old_path`, `new_path`,
`source`, `binary`, `is_test`, `insertions`, `deletions`, `diff_bytes`.

Secret paths fail with `SECRET_PATH` before any read. Binary files fail with
`BINARY_FILE`. Content over the body limit fails with `PAYLOAD_TOO_LARGE`; the
response never presents a truncated body as a complete file.

### Errors

`INVALID_ARGUMENT`, `INVALID_CURSOR`, `SECRET_PATH`, `BINARY_FILE`,
`PAYLOAD_TOO_LARGE`, `PATH_OUT_OF_SCOPE`, `SNAPSHOT_MISSING`, `RUN_NOT_FOUND`,
`STATE_CORRUPT`, `INTERNAL`.

## 4. review_status

Reads progress. Safe to call before or after sealing.

### Input

| Field | Type | Required | Notes |
| - | - | - | - |
| `review_id` | string | yes | |
| `section` | string | no | `summary` (default), `coverage`, `units`, `findings`, `verifications`, `report` or `gaps`. |
| `cursor` | string | no | Bound to the section. |
| `limit` | integer | no | Default 20, max 200. |

### Output

Common fields: `schema_version`, `review_id`, `status`, optional `next_cursor`.

| Section | Payload |
| - | - |
| `summary` | `summary`: `status`, `terminal`, `parent_review_id`, `snapshot`, `input`, `scope`, `background`, `rules_digest`, `assets_digest`, `counts`, optional `seal` (`intent`, `status`, `at`, `reason`). |
| `coverage` | `coverage`: the coverage object described in section 7. |
| `units` | `units`: array of `UnitSummary`. |
| `findings` | `findings`: array of `FindingView`. |
| `verifications` | `verifications`: array of `VerificationRecord`. |
| `report` | `report`: the derived report object described in section 9. |
| `gaps` | `gaps`: array of strings, the same list `finalize` checks. |

`FindingView` is a stored finding plus optional `latest_verification`:

- finding: `finding_id`, `unit_id`, `category`, `priority`, `trigger`,
  `impact`, `suggestion`, `location` (`path`, `side`, `start_line`,
  `end_line`, `snippet`), `digest`, `located`, `locate_note`, `evidence`,
  `revision`, `created_at`;
- verification: `verification_id`, `finding_id`, `verdict`, `rationale`,
  `evidence`, `finding_revision`, `request_key`, `at`.

### Errors

`INVALID_ARGUMENT`, `INVALID_CURSOR`, `RUN_NOT_FOUND`, `STATE_CORRUPT`,
`STATE_VERSION_UNSUPPORTED`, `INTERNAL`.

## 5. review_submit

Atomically records one unit outcome and its findings.

### Input

| Field | Type | Required | Notes |
| - | - | - | - |
| `review_id` | string | yes | |
| `unit_id` | string | yes | Must belong to the run. |
| `outcome` | string | yes | `reviewed`, `skipped` or `failed`. |
| `reason` | string | for `skipped` and `failed` | Concrete explanation. |
| `findings` | array | no | Only allowed with `reviewed`; at most 100 entries. |
| `request_key` | string | yes | |

`FindingInput` fields:

| Field | Required | Constraint |
| - | - | - |
| `category` | yes | `correctness`, `security`, `performance`, `maintainability`, `testing` or `redundancy`. Lowercased before validation. |
| `priority` | yes | `P0`, `P1`, `P2` or `P3`. Uppercased before validation. |
| `trigger` | yes | At most 4000 bytes. |
| `impact` | yes | At most 4000 bytes. |
| `suggestion` | no | At most 8000 bytes. |
| `location.path` | yes | Must be inside the unit (a cross-file unit may cite any snapshot file). Secret paths are rejected. |
| `location.side` | no | `old` or `new`; defaults to the unit side. |
| `location.start_line`, `location.end_line` | yes | Hints only. A matching range confirms the anchor; otherwise the snippet is searched. |
| `location.snippet` | yes | A snippet that is absent or matches several places is stored as an unlocated finding with a `locate_note`, not rejected. |
| `evidence` | no | References to other snapshot files, resolved the same way. |

### Output

| Field | Type | Notes |
| - | - | - |
| `schema_version` | string | |
| `review_id`, `unit_id`, `outcome` | string | The committed state. |
| `unit` | object | Updated `UnitSummary`. |
| `findings` | array | `FindingView` for the findings of this submission, or of the unit on replay. |
| `counts` | object | Updated run counts. |
| `replayed` | boolean | |

### Semantics

- Validation is complete before any write. One invalid finding rejects the
  whole batch and leaves the run unchanged.
- A unit can leave `pending` exactly once. A second submission with a different
  body returns `IDEMPOTENCY_CONFLICT`; the same body under the same key replays.
- Findings are validated against the frozen snapshot: path membership, secret
  exclusion, snippet relocation and evidence resolution.
- Unlocated findings are kept with `located: false` and a `locate_note`; they
  are never silently dropped.
- A sealed run rejects submissions with `RUN_SEALED`.

### Errors

`INVALID_ARGUMENT`, `INVALID_ANCHOR`, `PATH_OUT_OF_SCOPE`, `SECRET_PATH`,
`IDEMPOTENCY_CONFLICT`, `RUN_SEALED`, `RUN_NOT_FOUND`, `SNAPSHOT_MISSING`,
`STATE_CORRUPT`, `INTERNAL`.

## 6. review_verify

Appends one independent verdict for a finding.

### Input

| Field | Type | Required | Notes |
| - | - | - | - |
| `review_id` | string | yes | |
| `finding_id` | string | yes | `fnd_` followed by 16 to 64 lowercase hex characters. |
| `verdict` | string | yes | `confirmed`, `rejected` or `unresolved`. |
| `rationale` | string | yes | At most 8000 bytes. |
| `evidence` | array | no | Resolved against the snapshot. |
| `expected_revision` | integer | yes | At least 1. Must equal the finding's current `revision`. |
| `request_key` | string | yes | |

### Output

`schema_version`, `review_id`, `verification` (`VerificationRecord`),
`finding` (`FindingView`), `replayed`.

### Semantics

- Every verdict is retained. Rejected and unresolved findings are not deleted
  and not rewritten.
- A successful verification increments the finding's `revision`.
- A stale `expected_revision` returns `REVISION_CONFLICT` with
  `details.current_revision`. Refresh the finding from `review_status` and retry
  with the new revision under a new `request_key`.
- Same key and same body replays the stored verification instead of appending a
  second one.
- A sealed run rejects new verdicts with `RUN_SEALED`.

### Errors

`INVALID_ARGUMENT`, `REVISION_CONFLICT`, `IDEMPOTENCY_CONFLICT`, `RUN_SEALED`,
`RUN_NOT_FOUND`, `SNAPSHOT_MISSING`, `INVALID_ANCHOR`, `STATE_CORRUPT`,
`INTERNAL`.

## 7. review_finish

Seals a run and returns the terminal state plus stable report URIs.

### Input

| Field | Type | Required | Notes |
| - | - | - | - |
| `review_id` | string | yes | |
| `intent` | string | yes | `finalize`, `close_partial` or `cancel`. |
| `reason` | string | for `close_partial` | Why the review is incomplete. |
| `request_key` | string | yes | |

### Output

| Field | Type | Notes |
| - | - | - |
| `schema_version` | string | |
| `review_id` | string | |
| `status` | string | `completed`, `partial` or `cancelled`. |
| `intent` | string | Echo of the request intent. |
| `coverage` | object | Coverage at seal time. |
| `gaps` | array | Gaps at seal time. |
| `report_json_uri` | string | `review://runs/{review_id}/report.json`. |
| `report_markdown_uri` | string | `review://runs/{review_id}/report.md`. |
| `sealed_at` | string | RFC 3339 timestamp. |
| `replayed` | boolean | |

### Semantics

| Intent | Gate | Terminal status |
| - | - | - |
| `finalize` | No gaps: every unit is `reviewed` and every finding has at least one verdict. Otherwise `REVIEW_INCOMPLETE` with the gap list in `details`. | `completed` |
| `close_partial` | `reason` required. Gaps are preserved in the report. | `partial` |
| `cancel` | Gaps are preserved in the report. | `cancelled` |

- A sealed run rejects new submissions and verdicts with `RUN_SEALED`.
  Replaying the sealing request with its original key returns `replayed: true`
  instead of an error.
- A zero-change snapshot has no units, so `coverage.complete` is `true`
  (vacuously); the gap list is also empty, so `finalize` succeeds and seals as
  `completed`.
- Disconnecting the host, cancelling the process or losing the MCP connection
  never changes run state by itself. A run stays `active` until a finish
  request arrives.
- Reports are derived from run state on every read; there is no second stored
  copy that could diverge.

### Errors

`INVALID_ARGUMENT`, `REVIEW_INCOMPLETE`, `RUN_SEALED`, `IDEMPOTENCY_CONFLICT`,
`RUN_NOT_FOUND`, `STATE_CORRUPT`, `EXECUTION_TIMEOUT`, `INTERNAL`.

## 8. Run lifecycle and coverage

### Persisted state machine

`Run.status` has exactly four persisted values:

```
active --finish(finalize, no gaps)--> completed
active --finish(close_partial)------> partial
active --finish(cancel)-------------> cancelled
```

`Unit.status` has four values:

```
pending --submit(reviewed)--> reviewed
pending --submit(skipped) --> skipped
pending --submit(failed)  --> failed
```

A unit never leaves a terminal outcome. A run never leaves a terminal status.

### Procedural phases

The phases below are derived from state; they are not extra persisted statuses.
A client that wants to display a phase should compute it from `counts`,
`coverage` and the findings' latest verdicts.

| Phase | Observable condition |
| - | - |
| preparing | `review_prepare` is in flight. A successful call returns an `active` run. |
| reviewing | `coverage.pending + coverage.reviewed + coverage.skipped + coverage.failed` units exist and some are still `pending`. |
| verifying | Every required unit is `reviewed`, but at least one finding has no verdict, or a new finding was submitted after verification started. |
| finalizing | The caller has decided to seal; the next write is `review_finish`. |
| terminal | `status` is `completed`, `partial` or `cancelled`. |

### Coverage

Coverage is computed from units only (`internal/reviewcore/coverage.go`).

- `required` is the number of units planned at prepare time, including the
  cross-file unit. It never shrinks.
- `reviewed` counts units whose outcome is `reviewed`.
- `reused` is the subset of `reviewed` units that came from `resume_from`.
- `skipped`, `failed` and `pending` are counted separately and stay in the
  denominator.
- `complete` is `required > 0 && reviewed == required`.
- A skipped or failed unit is not covered, even though it has a terminal
  outcome.

Gaps, which gate `finalize`, are:

- one entry per unit that is `pending`, `skipped` or `failed`;
- one entry per finding with no recorded verdict.

A unit counts as reviewed only when all of its slices were submitted. Slicing
happens at prepare time, so a caller cannot reduce the denominator by sealing
early, and `close_partial` keeps the missing units visible in the report.

## 9. Reports

The report object is derived from the run on every read:

| Field | Notes |
| - | - |
| `schema_version`, `review_id`, `status`, `terminal` | Run identity and state. |
| `parent_review_id` | Present for a resumed run. |
| `snapshot`, `input`, `scope`, `background` | What was reviewed and why. |
| `rules_digest`, `assets_digest` | Which rules and which Skill/Agent set were in force. |
| `coverage` | The coverage object above. |
| `findings` | Stored findings plus `latest_verification`. |
| `verifications` | All verdicts, including rejected and unresolved ones. |
| `excluded` | Every exclusion with `path`, `side`, `reason`, `source`. |
| `gaps` | The same list used by `finalize`. |
| `generated_at` | Timestamp of this rendering. |

The Markdown rendering prints status and coverage before findings so a partial
run is not mistaken for a clean review. It sorts findings by priority, then
path, then line.

## 10. Error codes

| Code | Meaning | Typical trigger |
| - | - | - |
| `INVALID_ARGUMENT` | A field is missing, malformed or not allowed in this combination. | Bad `review_id`, unknown `unit_id`, unknown context `kind` or status `section`, unknown verdict or intent, invalid `request_key`, unknown skill URI, malformed report URI. |
| `INVALID_INPUT` | The review input or repository binding is invalid. | Missing input, unknown mode, refs set for `workspace`, control characters in a ref, repository root not a directory, state directory inside the repository. |
| `INPUT_CHANGED` | The worktree changed while a workspace snapshot was being captured. | Any status or content change between the two fingerprint passes. No run is created. |
| `SNAPSHOT_MISSING` | The frozen snapshot is gone or a run has none. | `resume_from` points at a run without a snapshot, or the snapshot directory was deleted. |
| `INVALID_ANCHOR` | A finding anchor is structurally invalid. | Missing `location.path` or snippet, or evidence whose line range falls outside the file. An absent or ambiguous snippet is not an error; it produces `located: false` with a note. |
| `PAYLOAD_TOO_LARGE` | The requested body exceeds the configured limit. | Unit diff over 64 KiB, file chunk over 64 KiB, file larger than 2 MiB, or one diff line over the body limit. |
| `IDEMPOTENCY_CONFLICT` | A request key was reused with a different body. | Changed input under the same prepare key, or a second different submission for an already terminal unit. |
| `REVISION_CONFLICT` | `expected_revision` does not match the finding. | Concurrent verification, or a stale finding snapshot. `details.current_revision` carries the live revision. |
| `RUN_SEALED` | The run is already terminal. | Submit or verify after `review_finish`. |
| `REVIEW_INCOMPLETE` | `finalize` was rejected because gaps remain. | Pending, skipped or failed units, or findings without a verdict. `details` is the gap list. |
| `PREPARATION_LIMIT` | Reserved for preparation budgets. | Declared in `internal/reviewcore/errors.go`; the current implementation has no preparation time budget and does not emit it. |
| `PREPARATION_FAILED` | Snapshot collection or rule loading failed. | Git plumbing failure while staging, unreadable system rules, unparsable project rule file, staging directory failure. |
| `EXECUTION_TIMEOUT` | A state lock could not be acquired in time. | Another process holds the run or index lock past the lock timeout. |
| `RUN_NOT_FOUND` | No run exists for the id. | Unknown `review_id`, including report reads. |
| `STATE_CORRUPT` | Persisted state is inconsistent. | Invalid run JSON, missing request-index entry, snapshot metadata mismatch, a committed unit or finding that disappeared. |
| `STATE_VERSION_UNSUPPORTED` | Persisted state uses an unknown schema version. | A state file written by a newer server. |
| `INVALID_CURSOR` | The cursor is malformed or belongs to another query. | Bad base64/JSON, or a cursor from a different review, snapshot, section or page size. A non-empty `skills/list` cursor is also rejected. |
| `PATH_OUT_OF_SCOPE` | The path is not part of this snapshot or unit. | Reading a path outside the snapshot, citing another file from a file unit. |
| `SECRET_PATH` | The path is a credential path. | Reading, searching, resolving rules for, or citing a secret path. This exclusion cannot be overridden. |
| `BINARY_FILE` | The content is not text. | Reading a binary file through `review_context`. |
| `GIT_FAILURE` | A git command failed or git is unavailable. | Missing git executable, empty `rev-parse --show-toplevel`, unresolvable ref. |
| `INTERNAL` | An unexpected failure. | JSON encoding failure or an error that is not a business error. |

All codes are defined in `internal/reviewcore/errors.go`. Clients branch on
`code`; they must not parse `message`.

## 11. Resources and URIs

### Static documents

| URI | MIME | Content |
| - | - | - |
| `skill://project/review/SKILL.md` | `text/markdown` | The main review workflow. |
| `agent://project/code-reviewer/agent.md` | `text/markdown` | Reviewer role definition. |
| `agent://project/review-verifier/agent.md` | `text/markdown` | Verification role definition. |

These appear in `resources/list` with name, description, MIME type and size.
The two agents are sorted by name. Reading one returns its full Markdown text.

### Report templates

| URI template | MIME | Content |
| - | - | - |
| `review://runs/{review_id}/report.json` | `application/json` | The report object. |
| `review://runs/{review_id}/report.md` | `text/markdown` | The rendered report. |

Both are readable for active and sealed runs. The URIs are also returned by
`review_finish`, so a client never needs to build them from scratch. The review
id must match `rv_...`; any other shape returns `INVALID_ARGUMENT`, an unknown
run returns `RUN_NOT_FOUND`. These URIs are server-specific resource names, not
Peri workspace resources, so Peri does not need to parse a scope from them.

### Peri URI syntax

Peri validates `skill://` and `agent://` URIs before it accepts a document
(`peri-acp-types/src/workspace_resources.rs`). Both shapes used here satisfy it:

```
skill://{scope}/{name}/{relative-path}
agent://{scope}/{name}/agent.md
```

Rules that matter for this server:

- `{scope}` is one of `user`, `global`, `project`, `plugin`, `builtin`. This
  server always publishes `project`.
- A non-plugin URI has one `{name}` segment. For a skill, `{name}` is the
  frontmatter `name` verbatim; for an agent, the definition id (file stem).
- A skill path is a non-empty relative path; `SKILL.md` is both the entry file
  and the first `resources[]` entry.
- An agent path must be exactly `agent.md`.
- Each segment must be non-empty, not `.` or `..`, at most 255 bytes, and must
  not contain `/`, `\`, `%`, `?`, `#`, NUL or control characters. `:` is
  allowed.
- The scheme is compared case-insensitively; there is no percent-decoding, so a
  published URI must not need encoding.

The server publishes no `user`, `global`, `plugin` or `builtin` resources, so a
URI with any other scope does not exist here even though Peri would accept its
syntax.

## 12. Skills extension wire shape

The extension is declared as `io.modelcontextprotocol/skills`. Two custom
methods support discovery. Both are defined in `internal/reviewmcp/skills.go`.

### skills/list

Request:

```json
{ "jsonrpc": "2.0", "id": 10, "method": "skills/list", "params": {} }
```

A non-empty `params.cursor` is rejected with `INVALID_CURSOR`; the Skill set is
small enough to return in one page.

Response:

```json
{
  "skills": [
    {
      "uri": "skill://project/review/SKILL.md",
      "frontmatter": {
        "name": "review",
        "description": "Run an evidence-based code review with the peri-code-review MCP server",
        "userInvocable": true,
        "argumentHint": "[range|commit|workspace] [background]"
      },
      "resources": [
        {
          "uri": "skill://project/review/SKILL.md",
          "digest": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
        }
      ]
    }
  ]
}
```

`nextCursor` is omitted when there is no next page.

- `skills` is the array of entries; `skills/get` returns one entry under the
  `skill` key. The entry shape is identical in both methods.
- `frontmatter` is the parsed YAML frontmatter rendered as JSON. The server's
  parser supports scalars, quoted strings, booleans and inline lists; block
  scalars are rejected at startup. `name` and `description` are required and
  must be non-empty strings, otherwise Peri rejects and isolates the entry.
- `resources` must be present and must include the SKILL.md entry itself.
  Each entry has `uri` and `digest`.
- `digest` is `sha256:` followed by 64 lowercase hex characters over the exact
  bytes served by `resources/read`. The body, the digest and the frontmatter all
  come from the same embedded file.

### skills/get

Request:

```json
{
  "jsonrpc": "2.0",
  "id": 11,
  "method": "skills/get",
  "params": { "uri": "skill://project/review/SKILL.md" }
}
```

Response:

```json
{ "skill": { "uri": "...", "frontmatter": {}, "resources": [] } }
```

Any other URI returns `INVALID_ARGUMENT` (`unknown skill URI`). `skills/get`
returns metadata only; read the SKILL.md body with `resources/read` on the same
URI. Peri performs that read itself and compares the digest before activation.

## 13. Security boundaries

### Repository access

- The server binds one repository at startup and keeps a snapshot per run.
  Tools never accept a repository path or a ref; `review_context` accepts only
  paths relative to the bound snapshot.
- Git runs as read-only plumbing (`rev-parse`, `merge-base`, `diff`,
  `ls-tree`, `cat-file`, `status`). No command writes to the worktree, the
  index or the refs, and nothing reads the worktree after `prepare` returns.
- Range and commit snapshots read fixed object ids, so a moving branch or a new
  commit cannot change what an existing run sees.
- Workspace snapshots copy reviewable new-side content under the state
  directory and fingerprint the worktree before and after collection.

### Secret paths

Secret paths are never stored in a snapshot, served, searched or accepted as
finding locations, even when a caller lists them in `scope.include`
(`internal/reviewcore/units.go`):

- base names `.env`, `.env.*`, `id_rsa`, `id_ed25519`, `credentials`,
  `credentials.json`, `secrets.yml`, `secrets.yaml`, `secret.yaml`;
- suffixes `.pem`, `.key`, `.p12`, `.pfx`, `.keystore`.

For range and commit inputs, git emits the diff of a secret path to the
subprocess pipe, but the server discards the text, hunks and line counts
immediately and keeps the change only as an exclusion. For a workspace
snapshot, such a path contributes size and mtime only to the fingerprint and no
copy is staged. Listing one as a finding returns `SECRET_PATH`, and reading one
returns `SECRET_PATH` before any bytes are loaded.

### Provider and test paths

- Provider directories (`.git`, `node_modules`, `vendor`, `dist`, `build`,
  `target`, `.next`, `.nuxt`, `coverage`, `.cache`, `__pycache__`, `.venv`)
  are excluded unless the caller lists the path in `scope.include`.
- Test files match the project test conventions and are included by default;
  `scope.include_tests: false` excludes them.
- Deleted-file impact is included by default; `scope.include_deleted: false`
  excludes it.
- Binary changes are excluded from units and reported in `excluded`.

### State directory

The state directory must be outside the repository. The check runs at startup
against the canonical git top level, so a symlink or relative path cannot hide
it inside the worktree. A rejected start produces a startup error, not a run.

### Output hygiene

- Tool results contain repository-relative paths only. The stored snapshot
  records its internal roots, but `SnapshotSummary`, which is what tools
  return, omits them.
- Git error messages replace the repository root with `<repo>` and the state
  directory with `<state>`, then collapse whitespace and truncate.
- The state root, `runs/`, `locks/` and `snapshots/` are created with mode
  0700; staged snapshot copies use 0600. Repository source is treated as
  private review input, not as world-readable cache data.
- Stdout is reserved for JSON-RPC; a diagnostic written there would corrupt the
  transport, so all logging goes to stderr.
- Secret content is never stored, served or logged. A workspace fingerprint
  reads size and mtime only for secret paths; range and commit diffs that git
  emits for a secret path are discarded before anything is persisted.
- Error messages quote only values that already belong to the review contract,
  such as ids, paths and enum values. File bodies and credential contents are
  never included.

### What the caller must not assume

- `review_id` is not an authentication token. Any client that can connect can
  read any run id it knows.
- A completed review is not a proof of correctness; coverage describes which
  units were processed, not what was missed.
- Verdicts record what a role reported. The server does not verify that two
  roles were independent executions.

## 14. Limits and defaults

All values are service defaults; the CLI passes zero values and gets these.

| Limit | Default | Applies to |
| - | - | - |
| Page size | 20 | Prepare units, status sections, manifest, exclusions |
| Max page size | 200 | Status and manifest |
| Max body | 64 KiB | Unit diff, diff page, file chunk, status report |
| File read lines | 200 default, 2000 max | `review_context` `kind=file` |
| Diff page lines | 2000 | `review_context` `kind=diff` |
| Search query | 500 bytes | `review_context` `kind=search` |
| Search page | 20 default, 100 max | `review_context` `kind=search` |
| Rule groups page | 5 default, 20 max | `review_context` `kind=rules` |
| Changed lines per file unit | 400 | Unit planning |
| Findings per submit | 100 | `review_submit` |
| Trigger and impact | 4000 bytes each | `review_submit` |
| Suggestion | 8000 bytes | `review_submit` |
| Rationale | 8000 bytes | `review_verify` |
| Request key | 200 bytes | All writes |
| Ref length | 512 bytes | `review_prepare` |
| Max file bytes | 2 MiB | Snapshot copies and reads |
| Max diff bytes | 4 MiB | Stored diff per change |
| Lock timeout | 30 s | State mutations |

A request that exceeds a body limit fails with `PAYLOAD_TOO_LARGE` rather than
returning a partial body. A page that has more content returns `next_cursor`.
