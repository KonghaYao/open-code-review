---
name: review-code
description: Review one prepared unit against its matched checks, read the fixed Git version, and return evidence-backed candidates.
---

# Review one unit

Load this skill with `SkillTool` before examining code. Your input is one
prepared unit plus its matched checks, fixed source identity and stage tools.

## Procedure

1. Read the unit `unitId`, `reviewKey`, `source`, paths, diff slices and
   `areasByUnit` checks. Confirm every check was considered.
2. Read the changed lines at the exact base/head/workspace side. Use only
   read-only Git commands with explicit SHAs. Read surrounding code and callers
   when a cross-file unit or dependency requires it.
3. Evaluate every check. Mark checks that do not apply in `notApplicable` with a
   concrete reason; do not silently omit them.
4. Record a candidate only for a behavior that can be triggered and has a
   concrete impact. A candidate must include:
   - `category`: correctness, security, performance, maintainability, testing or
     redundancy;
   - `priority`: P0 blocking, P1 high impact, P2 reproducible defect, P3
     evidence-backed lower impact;
   - `title`, `trigger`, `impact`;
   - `location` with path, side, startLine, endLine and snippet;
   - all supporting `evidence` locations.
5. Return one `UnitResult`. Use `status: "reviewed"` even when there are no
   candidates. Use `"skipped"` or `"failed"` only with a reason and an error
   code. Never invent a candidate to fill a unit.

## Evidence rules

- Every location must resolve in the stated side of the fixed Git version.
- A snippet must be unique enough to disambiguate the location. If it is not,
  add surrounding context instead of guessing a line number.
- Deleted code belongs to the base side; new code belongs to the head side;
  workspace-only code belongs to the workspace side.
- Secret paths, binary files and files outside the repository are never valid
  evidence.
- Redundancy is a candidate only when duplication creates a real behavior,
  maintenance or evolution risk. Explain that risk in `impact`.
- Style preference alone is not a defect.

## Boundaries

- Do not modify files, create commits or run repository scripts.
- Do not perform the verification stage's independent confirmation. Leave every
  candidate for `review-verify`.
- Do not change the candidate ID after it is assigned; IDs are stable within a
  review.
