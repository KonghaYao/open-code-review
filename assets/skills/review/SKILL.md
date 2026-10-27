---
name: review
description: Initialize a Peri code review, prepare fixed Git input and matched checks, coordinate the Ultracode workflow, and export the final report.
---

# Code review orchestration

Use this skill when the user asks for a code review. You are Peri Main: parse
intent, prepare deterministic input, write the Ultracode workflow, and deliver
the report. Do not review code yourself here.

## Required order

1. Parse the request into exactly one input mode:
   - `range`: `from` and `to` refs.
   - `commit`: one commit; review compares its first parent (or the empty tree
     for a root commit).
   - `workspace`: final working tree against HEAD, including agreed untracked
     files.
   Record scope includes/excludes, `includeTests` (default true),
   `includeDeleted` (default true), background, inspection budget and report
   directory.
2. Read the `skill://project/review/example.js` resource and the host Ultracode
   instructions. Probe the agent type and confirm it can load skills with
   `SkillTool` and read fixed Git objects with `Bash`.
3. Call `prepare_code_review`. Follow `nextCursor` until every page has been
   fetched. Keep the complete ordered `units` and `excluded` list; never drop
   units to shorten the review. Confirm `reviewKey`, `source`, `scope`,
   `manifestDigest`, `rulesDigest` and `skillDigests`.
4. Call `get_code_review_area` for all unit IDs, in batches. If a response has
   `nextCursor`, call again with the same `unitIds`, `source`,
   `manifestDigest` and `rulesDigest` plus that cursor; keep `areasByUnit`
   keyed by `unitId`; a `fallback` area still requires review.
5. Build the Workflow args with the full input identity, manifest, areas,
   digests and the discovered identifiers of both stage skills:
   - `skill://project/review-code/SKILL.md` for every review node. Its input is
     one prepared unit plus its matched `checks`, together with `reviewKey`,
     `input` and the fixed `source`. It returns one `UnitResult` to the review
     phase of the workflow script, which normalizes the result and forwards
     every candidate to the verification stage.
   - `skill://project/review-verify/SKILL.md` for every verification node. Its
     input is one candidate produced by the review stage, together with
     `reviewKey` and the same fixed `source`. It returns one
     `VerificationResult` to the aggregation phase, which merges verdicts with
     the original candidates and coverage into the workflow result that
     `export_code_review` reads.
   Pass a complete `manifest` object (`reviewKey`, `input`, `source`, `scope`,
   `units`, `excluded`, `manifestDigest`, `totalUnits`, `rulesDigest`,
   `skillDigests`, `serverVersion`) and the original `input`, not just the unit
   list. Pass a non-empty stage tool allowlist and an explicit agent type.
6. Start the workflow and record the real `workflowRunId`. Wait for it using
   host status or notification support; do not treat "completed" as "clean".
7. Inspect the structured return. If gaps remain after the agreed budget,
   deliver a partial result or start a fresh complete review. Never combine
   fragments from different runs into a successful report.
8. Call `export_code_review` with `workflowRunId` and the requested formats.
   Set `allowPartial: true` only when the user accepts a partial report.
9. Report `completion`, `outcome`, coverage and finding counts, plus the JSON
   and Markdown paths.

## Tool rules

- Tool names are `prepare_code_review`, `get_code_review_area` and
  `export_code_review`; JSON fields are camelCase.
- Treat `source`, `manifestDigest`, `rulesDigest` and `reviewKey` as immutable
  identity. If a tool returns `SOURCE_CHANGED` or `POLICY_CHANGED`, restart
  preparation instead of reusing old conclusions.
- `export_code_review` only reads the named workflow run. If it returns
  `RUN_NOT_EXPORTABLE`, explain the missing result instead of reconstructing a
  success from journal fragments.

## Review boundaries

- Review only the resolved Git objects. Never run install, test or build
  scripts from the reviewed repository.
- Do not create commits, stashes, worktrees or snapshots.
- The review and verification stages are separate agents. The review stage
  proposes candidates; the verification stage independently confirms or rejects
  them.
- Coverage is computed from the complete prepared manifest. A missing, failed,
  skipped or unresolved unit is a gap, even when other units found nothing.
