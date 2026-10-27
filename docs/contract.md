# Protocol contract

This document is the wire contract for `@konghaoyao/peri-code-review` 0.1.0.
It describes the stdio MCP surface, the three tools, the four public resources,
Peri's Skills extension shape (Contract C), the error envelope and the report
output layout.

The implementation lives in `src/mcp/server.ts`, with shared types and enums in
`src/domain/types.ts` and stable error codes in `src/domain/errors.ts`. Tool
names are snake_case; every JSON field is camelCase.

## 1. Transport and protocol

| Item | Value |
| - | - |
| Transport | stdio, newline-delimited JSON-RPC 2.0 |
| Supported revisions | `2026-07-28`, `2025-11-25`, `2025-06-18`, `2025-03-26` |
| Discovery | `server/discover` on the modern revision; `initialize` on 2025 revisions |
| Legacy opening | Rejected with `UnsupportedProtocolVersionError`; the connection stays open for a modern opening |
| Capabilities | `tools`, `resources`, extension `io.modelcontextprotocol/skills` |
| Server identity | package name and version from `package.json` |
| stdout | protocol messages only |
| stderr | diagnostics, argument errors and shutdown notices |

The modern revision must be listed explicitly in the server options; otherwise
the SDK does not install `server/discover`. One server process binds one
repository. There is no HTTP mode, no sampling, no roots and no model call.

`SIGINT` and `SIGTERM` close the server. stdin EOF closes the transport and
aborts in-flight requests. The process must not leave Git children, timers or
watchers behind.

## 2. Result and error envelope

A successful tool call returns:

```json
{
  "structuredContent": { "...": "the tool output object" },
  "content": [{ "type": "text", "text": "{\"...\":\"the same object\"}" }]
}
```

A business error returns `isError: true` and the same JSON payload in both
places:

```json
{
  "isError": true,
  "structuredContent": {
    "code": "SOURCE_CHANGED",
    "message": "workspace changed since the review input was resolved",
    "details": { "...": "optional structured context" }
  },
  "content": [{ "type": "text", "text": "{\"code\":\"SOURCE_CHANGED\",...}" }]
}
```

`code` is stable; clients branch on it. `message` is human-readable. `details`
is optional and its fields vary by failure.

| Code | Meaning |
| - | - |
| `INVALID_INPUT` | Missing, malformed or mutually exclusive input, unknown unit ID, unsafe path, or a repository/source mismatch. |
| `INVALID_CURSOR` | The page cursor is malformed, belongs to another query, manifest or review, or points past the end. |
| `SOURCE_CHANGED` | The resolved source no longer matches; for `workspace`, the content fingerprint changed. |
| `POLICY_CHANGED` | `rulesDigest` no longer matches the loaded rule catalog. |
| `INCOMPLETE_COVERAGE` | Export was requested with `allowPartial: false` but the run has gaps or unresolved findings. |
| `INVALID_FINDING` | A finding path, side, line range or identity is invalid; secret and provider paths are never readable. |
| `INVALID_ANCHOR` | A location cannot be verified against the claimed side. |
| `RUN_NOT_FOUND` | `workflowRoot` or the named run directory does not exist. |
| `RUN_NOT_EXPORTABLE` | The run has no complete return value: not completed, recorded an error, lacks `state.json`/`run.json`, or a long-text reference is missing. |
| `UNSUPPORTED_RUN_FORMAT` | The state envelope or result format is not understood, including `formatVersion != 1`. |
| `OUTPUT_CONFLICT` | A report with the same ID already exists with different content, or the output path is not a regular file. |
| `PREPARATION_FAILED` | Parsing the project rule policy failed. |
| `PAYLOAD_TOO_LARGE` | A state, output or rule file exceeds its readable limit. |
| `BINARY_FILE` | A binary file was requested as text. |
| `ASSET_NOT_FOUND` | A bundled skill, rule file or public resource is missing or malformed. |
| `NOT_IMPLEMENTED` | Reserved; not emitted by the current tools. |
| `INTERNAL_ERROR` | An unexpected failure. |

## 3. Review identity

`source` is the immutable Git identity bound to one review:

```json
{
  "repoId": "repo_<32 lowercase hex>",
  "mode": "range",
  "requestedRefs": { "from": "main", "to": "feature" },
  "baseSha": "<40 or 64 hex object id>",
  "headSha": "<40 or 64 hex object id>",
  "mergeBaseSha": "<40 or 64 hex object id>",
  "comparison": "merge-base"
}
```

| Mode | `requestedRefs` | `baseSha` | `headSha` | `comparison` |
| - | - | - | - | - |
| `range` | `{from, to}` | `merge-base(from, to)` | `to` | `merge-base` |
| `commit` | `{commit}` | first parent, or the Git empty tree for a root commit | the commit | `first-parent` |
| `workspace` | absent | HEAD | HEAD | `workspace-vs-head` |

Only `range` also sets `mergeBaseSha`. `workspace` on a repository with no
commits records empty `baseSha` and `headSha` strings; the SHA fields are
otherwise full object IDs. `workspace` adds `workspaceFingerprint`, a `sha256:`
digest over HEAD, the sorted status entries and each changed path's content
fingerprint. Secret paths contribute size and mtime only. `repoRoot` is never
sent to a client.

Digests are `sha256:` plus lowercase hex over canonical JSON (object keys sorted)
or raw UTF-8 bytes, depending on the field:

| Field | Covers |
| - | - |
| `manifestDigest` | Resolved source identity, normalized scope, the complete ordered unit list and exclusions. |
| `reviewKey` | Source identity, scope, `manifestDigest`, `rulesDigest`, `skillDigests` and `serverVersion`. |
| `rulesDigest` | The loaded system rule catalog. |
| `skillDigests` | The public skill/resource digests bound to this review. |
| `workspaceFingerprint` | HEAD, status entries and changed-path content. |

Raw ref names never enter `manifestDigest` or `reviewKey`; once refs resolve to
the same objects, a rebuild from a branch and from its SHA must agree.

## 4. prepare_code_review

Resolves one source and returns the complete ordered manifest. It has no review
lifecycle side effect and creates no run directory.

### Input

```json
{
  "input": {
    "mode": "range",
    "from": "main",
    "to": "feature"
  },
  "scope": {
    "include": ["src/**"],
    "exclude": ["docs/**"],
    "includeTests": true,
    "includeDeleted": true
  },
  "background": "Check the new retry path",
  "cursor": "<opaque page cursor>"
}
```

| Field | Type | Required | Rules |
| - | - | - | - |
| `input.mode` | `"range" \| "commit" \| "workspace"` | yes | Exactly one mode. |
| `input.from`, `input.to` | non-empty string | range only | Required together; `commit` is forbidden. |
| `input.commit` | non-empty string | commit only | `from` and `to` are forbidden. |
| `scope.include` | string[] | no | Empty means no include filter. |
| `scope.exclude` | string[] | no | Empty means no user exclusion. |
| `scope.includeTests` | boolean | no | Default `true`. |
| `scope.includeDeleted` | boolean | no | Default `true`. |
| `background` | string | no | Trimmed; omitted from output when empty. |
| `cursor` | non-empty string | no | Must belong to the same review key, manifest and query. |

Mode validation is rejected with `INVALID_INPUT` when refs from another mode are
present.

### Output

```json
{
  "source": {
    "repoId": "repo_0123456789abcdef0123456789abcdef",
    "mode": "range",
    "requestedRefs": { "from": "main", "to": "feature" },
    "baseSha": "<merge-base sha>",
    "headSha": "<head sha>",
    "mergeBaseSha": "<merge-base sha>",
    "comparison": "merge-base"
  },
  "scope": {
    "include": ["src/**"],
    "exclude": ["docs/**"],
    "includeTests": true,
    "includeDeleted": true
  },
  "background": "Check the new retry path",
  "units": [
    {
      "unitId": "u_0123456789abcdef",
      "kind": "file",
      "changeIds": ["ch_0123456789abcdef"],
      "paths": ["src/retry.ts"],
      "relatedPaths": [],
      "side": "head",
      "startLine": 12,
      "endLine": 40,
      "slices": [{ "hunkIndex": 0, "start": 0, "end": 20 }],
      "fullFile": false,
      "ruleRefs": [{ "source": "system", "pattern": "**/*.ts" }],
      "status": "pending"
    }
  ],
  "excluded": [
    {
      "path": "dist/bundle.js",
      "side": "head",
      "reason": "provider_directory",
      "source": "range"
    }
  ],
  "manifestDigest": "sha256:<64 hex>",
  "totalUnits": 17,
  "rulesDigest": "sha256:<64 hex>",
  "skillDigests": { "review": "sha256:<64 hex>" },
  "serverVersion": "0.1.0",
  "reviewKey": "sha256:<64 hex>",
  "nextCursor": "<opaque page cursor>"
}
```

`nextCursor` is absent on the final page. `totalUnits` is the full denominator
on every page, not the page size. Default page size is 100 units.

### Unit

```json
{
  "unitId": "u_<16 hex>",
  "kind": "file",
  "changeIds": ["ch_<16 hex>"],
  "paths": ["src/a.ts"],
  "relatedPaths": [],
  "side": "head",
  "startLine": 12,
  "endLine": 40,
  "slices": [{ "hunkIndex": 0, "start": 0, "end": 20 }],
  "fullFile": false,
  "ruleRefs": [{ "source": "system", "pattern": "**/*.ts" }],
  "status": "pending",
  "reason": "optional"
}
```

| Field | Rules |
| - | - |
| `unitId` | `u_` + 16 hex for a file unit; `u_cross_` + 16 hex for the cross-file unit. Stable across identical inputs. |
| `kind` | `file` or `cross_file`. |
| `changeIds` | `ch_` + 16 hex, hashed from source, status, old path and new path. |
| `paths` | Reviewable repository-relative paths; a rename keeps the new path first and the old path second. |
| `relatedPaths` | Additional paths a unit should inspect; never replaces `paths`. |
| `side` | `base`, `head` or `workspace`; the side that carries the unit's changed lines. |
| `startLine`, `endLine` | Inclusive line range on `side`; `0` for full-file and cross-file units. |
| `slices` | Raw hunk slices; each slice is at most 400 changed lines. |
| `fullFile` | `true` when the change has no hunks and the whole file is the unit. |
| `ruleRefs` | Rule identity only (`system` or `project` plus a glob); not rule text. |
| `status` | `pending`, `reviewed`, `failed` or `skipped`. New manifests always start at `pending`. |

Exactly one cross-file unit is generated when at least one path is included. It
is generated by a fixed rule, not by an agent, and it aggregates every included
path and change ID. File and cross-file units are never merged or replaced.

### ExcludedPath

```json
{
  "path": "dist/bundle.js",
  "side": "head",
  "reason": "provider_directory",
  "source": "range"
}
```

`reason` is one of `binary`, `secret_path`, `default_exclude`, `user_exclude`,
`tests_excluded`, `deleted_excluded`, `too_large`, `provider_directory` or
`unsupported`. Every changed path is either planned as a unit or listed here.
Secret paths always win over `include`; provider directories are `.git`,
`node_modules`, `vendor`, `dist`, `build`, `target`, `.next`, `.nuxt`,
`coverage`, `.cache`, `__pycache__` and `.venv`.

## 5. get_code_review_area

Rebuilds the manifest from `source` and the raw scope, compares both digests,
then returns the checks that apply to the requested units. It does not list or
serve the whole rule catalog.

### Input

```json
{
  "source": {
    "repoId": "repo_0123456789abcdef0123456789abcdef",
    "mode": "range",
    "requestedRefs": { "from": "main", "to": "feature" },
    "baseSha": "<merge-base sha>",
    "headSha": "<head sha>",
    "mergeBaseSha": "<merge-base sha>",
    "comparison": "merge-base"
  },
  "manifestDigest": "sha256:<64 hex>",
  "unitIds": ["u_0123456789abcdef", "u_cross_0123456789abcdef"],
  "rulesDigest": "sha256:<64 hex>",
  "input": { "mode": "range", "from": "main", "to": "feature" },
  "scope": { "include": ["src/**"], "includeTests": true },
  "cursor": "<opaque cursor>"
}
```

| Field | Required | Rules |
| - | - | - |
| `source` | yes | Must belong to the bound repository and match its mode/comparison. |
| `manifestDigest` | yes | Must equal the rebuilt manifest; otherwise `SOURCE_CHANGED`. |
| `unitIds` | yes | Non-empty, unique; an unknown ID is `INVALID_INPUT`. |
| `rulesDigest` | yes | Must equal the loaded catalog; otherwise `POLICY_CHANGED`. |
| `input` | no | Raw refs used to rebuild the manifest; recovered from `source` when omitted. |
| `scope` | no | Raw scope; defaults are applied. |
| `cursor` | no | Accepted for protocol symmetry. The current server returns every requested unit in one response and never emits `nextCursor`. |

### Output

```json
{
  "areasByUnit": [
    {
      "unitId": "u_<16 hex>",
      "areas": ["correctness", "testing"],
      "checks": [
        {
          "checkId": "chk_<16 hex>",
          "ruleId": "system:correctness-code",
          "text": "Check every return and failure path..."
        }
      ],
      "ruleIds": ["system:correctness-code"],
      "rulesDigest": "sha256:<64 hex>",
      "fallback": false
    }
  ]
}
```

`checkId` is stable for the same rule and check text, independent of unit and
path. `ruleId` is `system:<catalog id>` or `project:<glob>`. When no special
rule matches, the response still contains the generic fallback checks with
`fallback: true`; an empty rule set never means "nothing to review".

Matching uses the unit's path language, path category (`source`, `test`,
`config`, `ci`, `docs`, `build`, `dependency`, `unknown`), change kind
(`modified` or `deleted`), unit kind and glob patterns. Project guidance is read
from `.opencodereview/rule.json` at the fixed review source (not from the
worktree when the source is a commit), limited to 1 MiB. Each non-empty
paragraph becomes one `project:` check.

## 6. export_code_review

Reads one completed Ultracode run, validates it and writes the report.

### Input

```json
{
  "workflowRunId": "01a17c48-7f91-7501-96bc-3d6594b6c7a2",
  "formats": ["json", "markdown"],
  "allowPartial": false
}
```

| Field | Required | Rules |
| - | - | - |
| `workflowRunId` | yes | 1-200 bytes, matching `[A-Za-z0-9][A-Za-z0-9._-]*`; no separators or traversal. |
| `formats` | yes | Non-empty, unique subset of `json` and `markdown`. |
| `allowPartial` | no | Default `false`. When false, any gap or unresolved finding returns `INCOMPLETE_COVERAGE`. |

### Output

```json
{
  "status": "exported",
  "workflowRunId": "01a17c48-7f91-7501-96bc-3d6594b6c7a2",
  "reportId": "rpt_<16 hex>",
  "reviewKey": "sha256:<64 hex>",
  "completion": "complete",
  "outcome": "findings",
  "coverage": {
    "required": 17,
    "reviewed": 17,
    "reused": 0,
    "skipped": 0,
    "failed": 0,
    "pending": 0,
    "complete": true,
    "ratio": 1,
    "units": [
      {
        "unitId": "u_<16 hex>",
        "kind": "file",
        "paths": ["src/a.ts"],
        "status": "reviewed",
        "reused": false
      }
    ]
  },
  "findings": {
    "total": 2,
    "byPriority": { "P0": 0, "P1": 1, "P2": 1, "P3": 0 }
  },
  "files": [
    { "format": "json", "path": "/absolute/reports/rpt_<16 hex>.json", "digest": "sha256:<64 hex>" },
    { "format": "markdown", "path": "/absolute/reports/rpt_<16 hex>.md", "digest": "sha256:<64 hex>" }
  ],
  "gaps": [],
  "generatedAt": "2026-10-27T10:00:00.000Z"
}
```

`status` is `exported` for a complete report and `partial` when
`allowPartial: true` produced a report with gaps. `files` lists exactly the
requested formats, each already written before the response returns.

### Run record input

`--workflow-root` is read-only. For `<workflowRoot>/<workflowRunId>/`:

- The run directory must be a plain directory inside the real workflow root; a
  symlink or a path escape is rejected.
- `state.json` is preferred, then `run.json`. The file must be a regular file,
  at most 64 MiB, and valid JSON object.
- A state envelope requires `run_id` (state.json), `status: "completed"` and a
  non-empty `return_value`. `execution_status` must not be `running`, `failed`
  or `killed`; `acceptance_status` must not be `failed`;
  `post_processing_status` must not be `failed` or `blocked`; `delivery_status`
  must not be `blocked`; `error` must be empty. Engine `attempts`, when present,
  must have a matching `runId`, non-negative `journalSeq`, boolean `consumed` and
  a known `disposition`.
- A direct result object is accepted when it already contains `manifest`,
  `reviewKey` and `formatVersion`; an optional `run_id` must match and an
  optional `status` must be `completed`.
- Long strings may be stored as a complete `${label}` placeholder. The adapter
  reads `outputs/<label>.txt` inside the run directory, rejects path escapes and
  symlinks, and caps each file at 16 MiB.
- `journal.jsonl` is summarized only for failure details (entry counts, phases,
  last result). It is never used to reconstruct a successful return value.

The journal alone yields `RUN_NOT_EXPORTABLE`. A cancelled or crashed run with
no complete, acceptable return value is not exportable.

### Result input

The returned value must be a JSON object with `formatVersion: 1`. At minimum it
contains:

```text
reviewKey, input, manifest, areasByUnit, unitResults,
verificationResults, attempts, gaps, coverage
```

Export validates enums, normalized repository paths, line ranges, candidate and
verification relationships, duplicate IDs and identity consistency. It then
recomputes coverage and completion from `manifest.units`; the run's own coverage
counters are ignored.

The accepted stage result shapes are:

```ts
interface UnitResult {
  unitId: string;
  reviewKey: string;
  status: "reviewed" | "failed" | "skipped";
  checkedCheckIds: string[];
  notApplicable: { checkId: string; reason: string }[];
  candidates: Candidate[];
  error?: { code: string; message: string };
}

interface VerificationResult {
  candidateId: string;
  reviewKey: string;
  verdict: "confirmed" | "rejected" | "unresolved";
  reason: string;
  evidence: Location[];
  suggestedPriority?: "P0" | "P1" | "P2" | "P3";
}
```

`Location` is `{path, side, startLine, endLine, snippet}` with `side` one of
`base`, `head` or `workspace`, positive integer lines, `endLine >= startLine`
and a string snippet. A `Candidate` is `{candidateId, unitId, category,
priority, title, trigger, impact, location, evidence}`; categories are
`correctness`, `security`, `performance`, `maintainability`, `testing` and
`redundancy`.

## 7. Coverage and completion

Coverage is computed from the complete manifest, never from the run's reported
percentages:

- `required` is `manifest.units.length`.
- A unit counts as `reviewed` only if it has a `UnitResult`, its result status is
  `reviewed`, its review area exists, and every area check appears in either
  `checkedCheckIds` or `notApplicable`.
- Missing results, failed or skipped units, missing checks, unknown units,
  unknown candidates, missing verification, conflicting verification and
  unresolved verdicts all produce gaps.
- `ratio` is `null` when `required` is zero; `0/0` is never reported as 100%.

| `completion` | `outcome` | Rule |
| - | - | - |
| `complete` | `clean` | All required units are reviewed, no gaps, no confirmed findings, at least one unit. |
| `complete` | `findings` | All required units are reviewed, no gaps, at least one confirmed finding. |
| `complete` | `noChanges` | The manifest has zero units and no gaps. |
| `partial` | `inconclusive` | Any gap, unresolved finding or incomplete unit review. Confirmed findings are still shown. |

The engine's `completed` status only means execution stopped; it is never copied
as a review outcome.

## 8. Resources

`resources/list` returns exactly four static resources, in this order:

| URI | `mimeType` | Purpose |
| - | - | - |
| `skill://project/review/SKILL.md` | `text/markdown` | Peri Main orchestration skill. |
| `skill://project/review-code/SKILL.md` | `text/markdown` | Review-stage skill. |
| `skill://project/review-verify/SKILL.md` | `text/markdown` | Verification-stage skill. |
| `skill://project/review/example.js` | `text/plain` | Reference Ultracode workflow. |

`resources/read` returns `contents: [{uri, mimeType, text}]` for exactly these
URIs. There are no `agent://`, rule-catalog, report-template, `schema://` or
dynamic resources. The example is plain JavaScript without TypeScript-only
syntax; `node --check` accepts it and a workflow runner can execute it as-is.
The main skill references it and names both child skills with their inputs and
return targets.

Resource access is resolved from the installed package, not from
`process.cwd()`. The package root is found by realpath-resolving the executing
module and walking up until a directory containing both `package.json` and
`assets/` is found. That keeps the npm `.bin` symlink and
`--preserve-symlinks-main` working. Asset paths are rejected if they escape
`assets/`.

## 9. Skills extension (Contract C)

The server advertises `capabilities.extensions["io.modelcontextprotocol/skills"]
= {}` and registers two custom request methods. The SDK's built-in Skills
extension is deliberately not attached: it adds a mandatory `size` field to
every resource entry, so its serialization cannot match Peri's DTO.

### skills/list

Request: `{}` or `{"cursor": "..."}`.

```json
{
  "skills": [
    {
      "uri": "skill://project/review/SKILL.md",
      "frontmatter": {
        "name": "review",
        "description": "Initialize a Peri code review..."
      },
      "resources": [
        {
          "uri": "skill://project/review/SKILL.md",
          "digest": "sha256:<64 lowercase hex>"
        },
        {
          "uri": "skill://project/review/example.js",
          "digest": "sha256:<64 lowercase hex>"
        }
      ]
    }
  ]
}
```

The current server returns all three skills in one page and emits neither
`nextCursor`, `ttlMs` nor `cacheScope`. Resource entries contain exactly `uri`
and `digest`; there is no `size` field and no `"dynamic"` sentinel.

### skills/get

Request: `{"uri": "skill://project/review/SKILL.md"}`.

```json
{
  "skill": {
    "uri": "skill://project/review/SKILL.md",
    "frontmatter": { "name": "review", "description": "..." },
    "resources": [{ "uri": "skill://project/review/SKILL.md", "digest": "sha256:<64 hex>" }]
  }
}
```

An unknown skill URI returns JSON-RPC error `-32602` (Invalid params). Every
skill's `resources` list contains its own `SKILL.md`; the main skill also lists
`example.js`. Digests cover the raw UTF-8 bytes and use lowercase hex.

Frontmatter uses a small `key: value` YAML subset: plain, single-quoted or
double-quoted scalars. `name` must match the skill directory name and the URI,
and `description` must be non-empty. Complex YAML is not supported.

## 10. Report output layout

Reports are written only under `--output-dir`:

```text
<output-dir>/
  rpt_<16 hex>.json
  rpt_<16 hex>.md
```

The directory is created with mode `0700` when missing and must be a writable
directory after symlink resolution. `reportId` is `rpt_` plus
`shortHash(workflowRunId, contentDigest)`; `contentDigest` excludes the
`reportId` itself. Files are created with mode `0600` via a temporary file,
`fsync`, and an atomic hard link. A reader never sees a partial file.

If the target name exists with identical bytes, the existing file is reused and
its digest returned. If it exists with different bytes, or is a symlink or
non-regular file, the export returns `OUTPUT_CONFLICT`. All requested formats
must be written before success is returned; a failure removes files created by
that call.

### JSON model

```text
{
  identity: {
    formatVersion: 1,
    reportId,
    workflowRunId,
    reviewKey,
    packageVersion,
    rulesDigest,
    skillDigests
  },
  source,
  scope,
  manifest,
  completion,
  outcome,
  coverage,
  confirmed: ReportFinding[],
  rejected: ReportFinding[],
  unresolved: ReportFinding[],
  gaps,
  attempts,
  generatedAt
}
```

`ReportFinding` is the original `Candidate` plus `verdict`, an optional
`verification`, and `originalPriority`/`priorityChangeReason` when verification
changed the priority. Rejected and unresolved findings stay in the JSON; they
are not deleted.

### Markdown model

The Markdown file is rendered from the same `ReportModel` and contains:

1. Header with report ID, workflow run, review key, package version, rule and
   skill digests, generation time, completion and outcome.
2. `Source` table with repository ID, mode, base, head, comparison and refs.
3. `Scope` with include/exclude, tests, deletions, manifest totals, rule areas
   and excluded files.
4. `Coverage` table with required/reviewed/reused/skipped/failed/pending,
   complete flag and ratio; a `Completion` summary table follows.
5. `Confirmed findings (count)`, `Rejected findings (count)` and
   `Unresolved findings (count)`.
6. `Redundancy check` for confirmed candidates in the `redundancy` category.
7. `Gaps`, `Process` (stage attempts) and `Delivery` (formats, paths, digests).

## 11. Limits

| Limit | Value |
| - | - |
| Units per `prepare_code_review` page | 100 (`pageSize`) |
| Changed lines per file-unit slice | 400 |
| File content read | 2 MiB |
| Diff text per file | 4 MiB |
| Git invocation timeout | 120 s |
| Git output buffer | 64 MiB |
| Concurrent Git subprocesses | 8 |
| State snapshot read | 64 MiB |
| Long-text output read | 16 MiB |
| Journal read | 8 MiB |
| Project rule file | 1 MiB |
| `workflowRunId` | 200 bytes |

Limits are enforced by the server, not by callers. Over-limit files are excluded
or truncated with a reason; an unreadable run record fails export instead of
silently producing a partial success.
