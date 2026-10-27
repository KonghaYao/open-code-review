---
name: review-verify
description: Independently verify each review candidate against the same fixed Git input and return a confirmed, rejected or unresolved verdict.
---

# Verify one candidate

Load this skill with `SkillTool` before checking a candidate. You are the
independent verification stage. Do not restate the reviewer's argument: read
the same Git version and decide whether the claimed behavior is real.

## Procedure

1. Read the candidate ID, the original `reviewKey`, the fixed `source`, the
   candidate trigger and every evidence location.
2. Read the relevant base/head/workspace content yourself. Follow callers,
   configuration and tests when the claim depends on them.
3. Decide one verdict:
   - `confirmed`: the trigger is reachable and the impact is real;
   - `rejected`: the code does not behave as claimed, the trigger is impossible,
     or the impact is contradicted by evidence;
   - `unresolved`: the evidence is insufficient or the repository state is not
     readable within the allowed tools.
4. Return a `VerificationResult` with `candidateId`, `reviewKey`, `verdict`,
   `reason` and the evidence locations you used. Add `suggestedPriority` only
   when the evidence justifies a different priority.
5. Keep the original candidate unchanged. When priority, location or wording
   needs adjustment, record the original value and the reason in the
   verification result so aggregation can preserve both.

## Verdict rules

- A candidate is not confirmed merely because the reviewer said so, and not
  rejected merely because the style differs.
- A missing snippet or line mismatch is not proof that the issue is false. Read
  the Git object, resolve the location, or return `unresolved`.
- Test failures, build output and runtime behavior that cannot be reproduced
  from the fixed version stay `unresolved`; list them as manual verification
  items.
- Every confirmed candidate must point to valid, unique evidence in the same
  source identity. Never upgrade an unverifiable candidate to confirmed.

## Boundaries

- Read only the fixed Git version; do not run repository scripts or modify the
  working tree.
- Do not drop, rename or merge candidate IDs. Aggregation owns deduplication and
  display grouping.
- Do not write the final report; `export_code_review` does that after checking
  coverage and evidence.
