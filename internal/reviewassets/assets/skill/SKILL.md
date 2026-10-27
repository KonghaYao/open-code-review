---
name: review
description: "Run an evidence-based code review with the peri-code-review MCP server"
userInvocable: true
argumentHint: "[range|commit|workspace] [background]"
---

# Peri code review

This skill drives one review through the `peri-code-review` MCP server. The
server owns the frozen Git snapshot, unit splitting, anchoring, coverage and
reports. It never calls a model. You and the host agents do the reasoning.

## Discover first

1. Call `skills/get` for `skill://project/review/SKILL.md` if the host did not
   already load this skill.
2. Read the available agent definitions from `resources/list`. Use the exact
   IDs the host discovered; never hard-code the server name. A definition at
   `agent://project/code-reviewer/agent.md` is normally projected as
   `mcp__<server>__code-reviewer`.

## Workflow

1. **Prepare** with `review_prepare`.
   - Choose exactly one input mode: `range` (`from` + `to`), `commit`, or
     `workspace`.
   - Scope defaults to tests and deleted-file impact included. Only narrow it
     when the user asked.
   - Pass the user's intent as `background`.
   - Use a stable `request_key` such as `prepare:<conversation-or-task-id>`.
   - Keep `review_id`; every later call is bound to it.
   - Read `rules_digest` and `assets_digest`; they identify the frozen policy.

2. **Review units** in the returned order. For each unit:
   - Call `review_context` with `kind: "unit"`, `review_id` and `unit_id` to
     get the bounded diff and the rules that apply to those paths.
   - Read related callers, configs, protocol references and tests with
     `review_context` (`kind: "search"` or `kind: "file"`); never read the
     worktree directly.
   - Delegate the unit to the discovered `code-reviewer` agent, or do the
     analysis yourself when the host does not allow delegation. Give the agent
     the `review_id`, `unit_id`, and the returned rules.
   - Submit each unit exactly once with `review_submit`. Use a stable key
     `submit:<review_id>:<unit_id>`. The result is atomic: one invalid finding
     rejects the whole batch.
   - `outcome: "reviewed"` may carry an empty findings list. Use
     `skipped`/`failed` only with a concrete reason; those units stay
     incomplete and block `finalize`.

3. **Finding quality**:
   - Every finding needs `category`, `priority` (`P0`-`P3`), `trigger`,
     `impact`, and a location with `path`, `side`, `start_line`, `end_line`
     and `snippet`.
   - The snippet is authoritative. If it is ambiguous, add surrounding lines.
     Never guess a line number.
   - Cite supporting code in `evidence` (path/side/lines/snippet/note). Evidence
     may point at unchanged files.
   - Do not submit style nits, duplication that is already intentional, or
     findings you cannot explain. The cross-file unit exists to catch callers,
     configuration, protocol and test gaps that single-file units miss.

4. **Verify every finding** with the discovered `review-verifier` agent.
   - Fetch findings with `review_status` (`section: "findings"`).
   - For each finding call `review_verify` with the finding's current
     `revision` as `expected_revision`, a verdict (`confirmed`, `rejected`,
     `unresolved`) and a rationale.
   - A rejected or unresolved verdict is still a recorded conclusion. Never
     delete a finding; the host keeps the history.
   - If a concurrent verifier wins, refresh the finding and retry with the new
     revision.

5. **Finish** with `review_finish`.
   - `intent: "finalize"` only after every required unit is reviewed and every
     finding has a verdict. If the server returns `REVIEW_INCOMPLETE`, read the
     gaps, finish the missing work, and retry.
   - `intent: "close_partial"` requires a reason and records the remaining
     gaps. `intent: "cancel"` preserves work but marks the run cancelled.
   - Report the two returned URIs: `review://runs/<review_id>/report.json` and
     `.md`. Read them with `resources/read` when the host needs the rendered
     report.

## Error handling

- `IDEMPOTENCY_CONFLICT`: the request key was reused with a different body.
  Generate a new key for the new logical operation; never silently change the
  old body.
- `REVISION_CONFLICT`: re-read the finding and use the new revision.
- `RUN_SEALED`: the run is terminal; prepare a new run (and use `resume_from`
  to reuse completed units).
- `INVALID_ANCHOR`: the snippet did not identify one location. Add context and
  resubmit the unit with the same key only if the body is unchanged; otherwise
  use a new key.
- `INPUT_CHANGED`: the workspace moved during snapshot collection. Re-run
  `review_prepare` with a new request key.
- `SNAPSHOT_MISSING` / `STATE_CORRUPT`: stop and report the state directory to
  the user; do not fall back to the current worktree.

## Non-negotiables

- The server is read-only with respect to the repository; do not ask it to
  apply patches.
- Credentials and secret paths are excluded from diffs, reads and searches.
  Do not attempt to bypass that exclusion.
- Coverage is an accounting fact, not proof that no issue exists. State the
  reviewed scope and unresolved items in the final answer.
