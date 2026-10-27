# Internal rule catalog

This directory holds the rules that `get_code_review_area` matches. The catalog
is package-private: it is not published as an MCP resource and there is no
tool that lists or downloads the whole catalog. Only the checks for requested
units leave the process.

## Why this catalog replaces the Go rule documents

The previous Go implementation mapped about sixty path patterns to large
Markdown documents (`internal/config/rules/system_rules.json` plus
`rule_docs/`). That format has no per-check identity, so it cannot produce the
stable `checkId`, `ruleId` or category fields the TypeScript contract requires,
and returning a whole language document for every changed file would not match
the "relevant checkpoints per unit" requirement. This version keeps the useful
part of the old behavior - language and path matching, with a generic fallback
- and expresses the checks as structured entries instead. The Go catalog is
left untouched for the legacy implementation.

## Files

| File | Purpose |
| --- | --- |
| `system-rules.json` | The bundled system catalog |
| `RULES.md` | This document |

## System catalog schema

```json
{
  "formatVersion": 1,
  "version": "1.0.0",
  "fallback": {
    "area": "general",
    "checks": ["A generic checkpoint"]
  },
  "rules": [
    {
      "id": "correctness-language-typescript",
      "area": "correctness",
      "description": "Why the rule exists",
      "appliesTo": "file",
      "languages": ["typescript", "javascript"],
      "pathCategories": ["source"],
      "patterns": ["**/*.ts"],
      "changeKinds": ["modified"],
      "checks": ["A concrete checkpoint"]
    }
  ]
}
```

- `formatVersion` must be `1`.
- `version` is a display version; the effective identity is the digest of the
  parsed catalog.
- `fallback` is returned with `fallback: true` when no rule matches a unit.
  An empty result is never interpreted as "nothing to review".
- `id` must be unique and match `^[a-z0-9][a-z0-9-]*$`. The exposed rule ID is
  `system:<id>`.
- `area` is a free-form review area. The bundled catalog uses
  `correctness`, `security`, `performance`, `maintainability`, `testing`,
  `redundancy`, and `cross-file`. `general` is reserved for the fallback.
- `appliesTo` is `file`, `cross_file` or `both` (default `both`).
- Selectors combine with AND:
  - `languages` matches the language derived from the file extension;
  - `pathCategories` matches `source`, `test`, `config`, `ci`, `docs`,
    `build`, `dependency` or `unknown`;
  - `patterns` matches any glob against the repository-relative path;
  - `changeKinds` matches `modified` or `deleted`.
- A rule that can apply to file units must declare at least one selector,
  otherwise it would match every path. Only a `cross_file`-only rule may omit
  selectors.
- `checks` must be a non-empty list of non-empty strings.

Every system rule whose selectors match a path is returned. This is a deliberate
difference from the Go resolver's first-match-wins behavior: the structured
checks make it safe to return several areas for the same file, which is what
lets one TypeScript change receive correctness, security, performance,
maintainability, testing and redundancy checks at once. Catalog order is
preserved in the response.

## Change kinds

A unit carries `side` and `slices`, not the original diff status. `deleted` is
therefore derived from `side: "base"`; every other unit is `modified`. A
cross-file unit describes a mixed change set and is always treated as
`modified`. Added and modified files cannot be distinguished reliably from the
unit alone, so no selector uses `added`. This is documented instead of guessed.

Language detection uses the file extension. Path categories are classified in
this order: test, CI, dependency, build, docs, config, source, unknown. A file
whose language or category is unknown still receives the fallback checks.

## Project rules

The repository may contain `.opencodereview/rule.json` with the same schema as
the legacy Go implementation:

```json
{
  "rules": [
    { "path": "**/*.go", "rule": "Project guidance text", "merge_system_rule": true }
  ],
  "include": ["src/**"],
  "exclude": ["**/generated/**"]
}
```

- The file is read from the fixed review source: `git show <headSha>:...` for
  `range` and `commit`, and the worktree for `workspace`. It is never fetched
  from the network. A missing file is a normal configuration, not an error.
- A binary file, a file larger than 1 MiB, invalid JSON, a non-object entry or a
  malformed glob fails preparation with `PREPARATION_FAILED`. Unsupported
  content is never silently dropped.
- Patterns are matched case-insensitively. Brace alternation such as
  `*.{ts,tsx}` is supported by the shared glob matcher.
- Project entries use first-match-wins in declaration order. An entry with an
  empty `rule` and `merge_system_rule: false` is disabled and skipped.
- `include` (when non-empty) and `exclude` scope which paths may receive project
  rules. They do not remove a unit: a file outside the project scope is still
  reviewed with system rules. Unit exclusion belongs to `src/repository`.
- `merge_system_rule: true` keeps the matched system checks and adds the project
  text as `project:<path>` checks. `false` replaces the system checks for that
  path. This is the structured equivalent of the legacy
  "System-Specific Rules / User-Specific Rules" merged text.
- Project rule text is split into paragraphs separated by blank lines; each
  paragraph becomes one check. A `merge_system_rule` entry with empty text adds
  no check.

## Identity

- System checks expose `chk_` plus the first 16 hex characters of
  `sha256(ruleId + NUL + checkText)`. The ID is stable for the same catalog and
  the same text, and is independent of the unit or path.
- `rulesDigest` is `sha256:` plus the SHA-256 of the canonical JSON of the
  validated system catalog. Formatting changes do not alter it; any semantic
  change does.
- Project rules are intentionally outside `rulesDigest`. The project file is
  part of the fixed source, so a rule edit changes `headSha` (workspace edits
  change the workspace fingerprint), which already changes `reviewKey` and
  `manifestDigest`. A source-independent digest cannot include a
  source-dependent file.
- All loading is local: bundled assets plus the bound repository. No rule
  resolution performs a network request.
