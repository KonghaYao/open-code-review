# peri-code-review

TypeScript MCP server that gives Peri and Ultracode deterministic code review
input: fixed Git sources, a complete review manifest, matched internal rule
checks, and validated JSON/Markdown report export.

The server does not call a model, create agents or run the workflow. Peri owns
the model and Ultracode owns execution; this process provides data, rules,
resource distribution and export validation over stdio. It never edits the
reviewed repository, creates commits or snapshots, uploads results, or posts
review comments.

This repository is the pure TypeScript replacement for the previous Go server.
The Go CLI, six-tool protocol, state store and snapshots have been removed. See
[docs/migration.md](docs/migration.md) for the mapping and remaining limits,
and [docs/contract.md](docs/contract.md) for the exact protocol contract.

## Status

Version `0.1.0` is **not published to npm yet**. Install the packed tarball
today; the `npx` form works after the maintainer publishes the package. Pin an
exact version in Peri configuration rather than using `latest`.

## Requirements

- Node.js 24 or newer. CI covers Node 24 and 26.
- `git` on `PATH`.
- A Git work tree to review. One server process is bound to one repository.
- Peri with Ultracode for an actual review. This package alone never reviews
  code.

## Install

Build a tarball from a checkout and install it globally:

```sh
npm ci
npm pack
npm install -g ./konghaoyao-peri-code-review-0.1.0.tgz
peri-code-review version
```

Or install it into a local tool directory and call the binary there:

```sh
npm install ./konghaoyao-peri-code-review-0.1.0.tgz
./node_modules/.bin/peri-code-review version
```

`npm pack` runs `prepack`, which builds `dist/` with tsup. The tarball contains
compiled JavaScript, the three skills, the workflow example and the internal
rule catalog. There are no install scripts, native binaries or build tools
needed at runtime.

After the package is published, start it without a global install:

```sh
npx -y @konghaoyao/peri-code-review@0.1.0 serve \
  --repo /absolute/path/to/repository \
  --output-dir /absolute/path/to/review-reports
```

## Run

```sh
peri-code-review serve --repo <path> [--workflow-root <path>] [--output-dir <path>]
```

| Command or option | Default | Meaning |
| - | - | - |
| `serve` | - | Start the stdio MCP server for one repository. |
| `help` | - | Print usage, tools and public resource URIs. |
| `version` | - | Print the package version. |
| `--repo <path>` | required | Repository root to bind. Relative paths resolve from the current directory. |
| `--workflow-root <path>` | `<repo>/.claude/workflow-runs` | Read-only root of Ultracode run records. |
| `--output-dir <path>` | `~/.peri/reports/code-review` | Writable destination for JSON and Markdown reports. |

`serve` waits for an MCP client. It does not start a review by itself. stdout
carries JSON-RPC messages only; diagnostics and shutdown notices go to stderr.
EOF on stdin, `SIGINT` and `SIGTERM` close the server without leaving child
processes or timers behind.

### Peri configuration

```json
{
  "mcpServers": {
    "peri-code-review": {
      "command": "npx",
      "args": [
        "-y",
        "@konghaoyao/peri-code-review@0.1.0",
        "serve",
        "--repo",
        "/absolute/path/to/repository",
        "--workflow-root",
        "/absolute/path/to/repository/.claude/workflow-runs",
        "--output-dir",
        "/absolute/path/to/review-reports"
      ],
      "system_mcp": true,
      "system_mcp_tools": [
        "prepare_code_review",
        "get_code_review_area",
        "export_code_review"
      ]
    }
  }
}
```

For a stable offline setup, install the tarball into a dedicated directory and
use `command: "node"` with the first argument
`/absolute/path/node_modules/@konghaoyao/peri-code-review/dist/cli.js`, followed
by the same `serve` arguments. After installation the server does not download
anything.

## Tools

Tool names are snake_case; every JSON field is camelCase. Each successful call
returns `structuredContent` and the same object serialized as text. Business
errors return `isError: true` with a stable `code`, a `message` and optional
`details`.

| Tool | Purpose |
| - | - |
| `prepare_code_review` | Resolve one fixed Git source, build the complete ordered manifest, list exclusions and return the review identity. |
| `get_code_review_area` | Rebuild the manifest, verify its digest and rule digest, then return matched areas, checks and rule IDs for requested units. |
| `export_code_review` | Read one completed Ultracode run, revalidate structure, coverage and findings, then write JSON and Markdown reports. |

`prepare_code_review` accepts one of three input modes: `range` (`from`/`to`,
compared from `merge-base(from, to)` to `to`), `commit` (first parent to the
commit, or the empty tree for a root commit), or `workspace` (the working tree
against HEAD, including untracked files). `workspace` is fingerprinted rather
than frozen; a changed fingerprint returns `SOURCE_CHANGED`.

The complete manifest is paged. Default page size is 100 units. Follow
`nextCursor` until it is absent; a cursor is bound to the review key, manifest
digest and query, so a cursor from another input returns `INVALID_CURSOR` and
never mixes two manifests. `totalUnits` is the full coverage denominator on
every page.

Error codes include `INVALID_INPUT`, `INVALID_CURSOR`, `SOURCE_CHANGED`,
`POLICY_CHANGED`, `INCOMPLETE_COVERAGE`, `INVALID_FINDING`, `INVALID_ANCHOR`,
`RUN_NOT_FOUND`, `RUN_NOT_EXPORTABLE`, `UNSUPPORTED_RUN_FORMAT`,
`OUTPUT_CONFLICT`, `PREPARATION_FAILED`, `PAYLOAD_TOO_LARGE`, `BINARY_FILE`,
`ASSET_NOT_FOUND` and `INTERNAL_ERROR`.

## Skills and resources

The public surface is exactly three skills and one workflow example:

| URI | Content | Used by |
| - | - | - |
| `skill://project/review/SKILL.md` | Initialization, input parsing, sub-skill hand-offs, orchestration and delivery rules. | Peri Main |
| `skill://project/review-code/SKILL.md` | Per-unit review method, evidence rules and candidate return shape. | Review stage |
| `skill://project/review-verify/SKILL.md` | Independent verification method, verdicts and evidence rules. | Verification stage |
| `skill://project/review/example.js` | Reference Ultracode review/verify/aggregate workflow. | Peri Main reference |

All four are readable with `resources/read`. The main skill's resource list
contains its own `SKILL.md` and `example.js`; each child skill lists its own
`SKILL.md`. The example is plain JavaScript with no TypeScript-only syntax, so a
workflow runner can execute it as-is.

Skills are discovered through two custom request methods, registered as
`io.modelcontextprotocol/skills`:

- `skills/list` returns `{"skills":[{"uri","frontmatter","resources":[{"uri","digest"}]}]}`.
- `skills/get` with `{"uri"}` returns `{"skill":{...}}`; an unknown skill URI is
  rejected with `-32602` (Invalid params).

Resource references deliberately contain only `uri` and `digest`; there is no
`size`, `ttlMs` or `cacheScope`, and the SDK's built-in Skills extension is not
attached because it adds a mandatory `size` field. A digest is
`sha256:` followed by 64 lowercase hex characters over the raw UTF-8 bytes.
No `agent://`, rule-catalog, report-template or `schema://` resources are
published. The internal rule catalog is reachable only through
`get_code_review_area`.

## Reports

`export_code_review` writes two files derived from one validated report model:

```text
<output-dir>/<reportId>.json
<output-dir>/<reportId>.md
```

`reportId` is `rpt_` plus a 16-character hexadecimal content identity derived
from the workflow run ID and the validated report content. The response lists
each written format with its absolute path and `sha256:` digest.

The JSON file is the complete machine result: identity (`formatVersion`,
`reportId`, `workflowRunId`, `reviewKey`, package version, rule and skill
digests), Git source, scope, full manifest, completion and outcome, coverage,
confirmed/rejected/unresolved findings, gaps, attempts and generation time. The
Markdown file renders the same model for people, including source, scope,
coverage, findings by verdict, redundancy checks, gaps and delivery details.

Writes are atomic, files are created with mode `0600`, and an existing report is
never overwritten. Re-exporting identical content reuses the existing file; an
identical `reportId` with different content returns `OUTPUT_CONFLICT`.

Coverage is recomputed from the prepared manifest, never trusted from the
workflow result. A unit is `reviewed` only when its result exists and every
check handed out for it is either checked or explicitly marked not applicable.
Missing, failed, skipped, pending or unresolved results become gaps. `complete`
with `noChanges` reports a null ratio rather than `0/0 = 100%`.

## Security boundaries

- **Repository binding.** The process is started with one `--repo`. Tool input
  cannot switch repositories; a `source` from another repository is rejected by
  its repository ID.
- **Read-only review input.** Git is invoked with argument arrays, never a shell
  string, with fixed environment settings, a two-minute timeout, a bounded
  output buffer and a subprocess concurrency limit. Commits are resolved once
  and read by SHA.
- **No repository execution.** The server does not run install, test, build or
  hook scripts from the reviewed repository and does not create stashes,
  commits, worktrees or snapshots.
- **Secret handling.** `.env` files, private keys, credential files and similar
  paths are hard-excluded from diffs, reads and findings. `include` patterns
  cannot override the exclusion.
- **Read-only workflow root.** `--workflow-root` is never modified. Run IDs,
  snapshot files, long-text references and symlinks are checked so reads cannot
  escape the run directory. The journal is used only for failure details; it is
  never treated as a successful result.
- **Writes go to one directory.** Reports are written only under
  `--output-dir`, after rejecting traversal and symlink escapes, and are never
  overwritten.
- **Bounded input.** Files over 2 MiB and diffs over 4 MiB are excluded or
  truncated with an explicit reason; state snapshots, long-text outputs and
  journals have separate read limits.
- **Local only.** There is no HTTP server, no network lookup, no sampling and no
  model call. Reports stay on the local machine.

These are application-level boundaries, not an operating-system sandbox.
Workflow nodes that read Git with Bash operate under the host's permissions and
must be given an explicit, read-only tool allowlist by Peri.

## Migration from the Go server

| Go tool | TypeScript replacement |
| - | - |
| `review_prepare` | `prepare_code_review` |
| `review_context` | `get_code_review_area` (rules only; nodes read Git directly) |
| `review_status` | Removed; coverage and completion are recomputed by `export_code_review`. |
| `review_submit` | Removed; review agents return `UnitResult` objects in the workflow result. |
| `review_verify` | Removed; verification agents return `VerificationResult` objects. |
| `review_finish` | `export_code_review` |

The `--state-dir` option, `PERI_CODE_REVIEW_STATE_DIR`, the review store, frozen
snapshots, request keys, `agent://` resources and `review://` report templates
are all gone. State now lives in the Ultracode run record and the report output
directory. See [docs/migration.md](docs/migration.md) for the full mapping and
known limitations.

## Development

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run smoke:cli
npm pack --dry-run
```

- `npm test` runs Vitest over `src/**/*.test.ts`.
- `npm run build` writes `dist/cli.js` and `dist/index.js` with tsup.
- `npm run smoke:cli` links `dist/cli.js` as `.bin/peri-code-review` in a
  temporary directory and runs `version` and `help` through that symlink,
  including `--preserve-symlinks-main`. It fails on empty output or a nonzero
  exit, which is how a broken npm bin used to slip through.
- `npm pack --dry-run` shows the exact published file list after `prepack`.
- `npm run dev -- serve --repo <path>` runs the CLI from source with tsx.

Source layout:

| Path | Responsibility |
| - | - |
| `src/cli.ts`, `src/mcp/server.ts` | stdio entry, protocol wiring, tools, resources and skills methods. |
| `src/git/`, `src/repository/` | Git subprocess boundary, diffs, manifest, units, locations and workspace fingerprints. |
| `src/rules/` | Private rule catalog, project rules and per-unit check matching. |
| `src/domain/`, `src/report/`, `src/run/` | Types, errors, coverage, report rendering and the read-only Ultracode run adapter. |
| `src/dev/smoke-cli.ts` | Release gate that executes the built CLI through an npm-style bin symlink. |
| `assets/skills/`, `assets/workflow/`, `assets/rules/` | Published skills and example, plus the internal rule catalog. |

## License

Apache-2.0. See [LICENSE](LICENSE).
