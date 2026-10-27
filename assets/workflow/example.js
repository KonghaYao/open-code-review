// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
/**
 * Reference Ultracode workflow for Peri Main.
 *
 * It is deliberately not a fixed business process: adjust batching and budgets,
 * but keep the input identity, both stage skills, structured hand-offs and
 * coverage checks. This file is plain JavaScript so a workflow runner can
 * execute it as-is.
 *
 * Host globals (provided by Ultracode, never imported):
 *   agent(prompt, options), parallel(tasks), phase(name), args
 *
 * `meta` and the aggregated workflow result are module exports, so the script
 * stays a valid ES module that `node --check` accepts.
 */

const reviewSchema = { type: 'object' };
const verificationSchema = { type: 'object' };

function reviewPrompt(unitId) {
  const unit = args.manifest.units.find((entry) => entry.unitId === unitId);
  const area = args.areasByUnit.find((entry) => entry.unitId === unitId);
  return [
    'Load ' + args.reviewSkillUri + ' with SkillTool before reviewing.',
    'reviewKey: ' + args.reviewKey,
    'input: ' + JSON.stringify(args.input),
    'source: ' + JSON.stringify(args.source),
    'unit: ' + JSON.stringify(unit),
    'checks: ' + JSON.stringify(area === undefined ? [] : area.checks),
    'Return one UnitResult. Keep failed or skipped units at their original index.',
  ].join('\n');
}

function verifyPrompt(candidate) {
  return [
    'Load ' + args.verifySkillUri + ' with SkillTool before verifying.',
    'reviewKey: ' + args.reviewKey,
    'source: ' + JSON.stringify(args.source),
    'candidate: ' + JSON.stringify(candidate),
    'Read the same fixed Git version independently and return one VerificationResult.',
  ].join('\n');
}

function normalizeReview(unitId, raw) {
  if (raw === undefined || raw === null) {
    return {
      unitId,
      reviewKey: args.reviewKey,
      status: 'failed',
      checkedCheckIds: [],
      notApplicable: [],
      candidates: [],
      error: { code: 'STAGE_NO_RESULT', message: 'Review node returned no result' },
    };
  }
  return {
    ...raw,
    unitId,
    reviewKey: args.reviewKey,
    candidates: raw.candidates.map((candidate, index) => ({
      ...candidate,
      candidateId: unitId + ':c' + String(index + 1),
      unitId,
    })),
  };
}

function collectCandidates(reviews) {
  return reviews.flatMap((review) => review.candidates);
}

function normalizeVerification(candidate, raw) {
  if (raw === undefined || raw === null) {
    return {
      candidateId: candidate.candidateId,
      reviewKey: args.reviewKey,
      verdict: 'unresolved',
      reason: 'Verification node returned no result',
      evidence: [],
    };
  }
  return { ...raw, candidateId: candidate.candidateId, reviewKey: args.reviewKey };
}

function aggregate(reviews, verifications) {
  const required = args.manifest.units.length;
  const reviewed = reviews.filter((review) => review.status === 'reviewed').length;
  const failed = reviews.filter((review) => review.status === 'failed').length;
  const skipped = reviews.filter((review) => review.status === 'skipped').length;
  const unverified = collectCandidates(reviews).filter(
    (candidate) => verifications.some((result) => result.candidateId === candidate.candidateId) === false,
  );
  const confirmed = verifications.filter((result) => result.verdict === 'confirmed');
  const gaps = [
    ...reviews
      .filter((review) => review.status !== 'reviewed')
      .map((review) => ({ code: 'UNIT_INCOMPLETE', message: review.unitId, unitId: review.unitId })),
    ...unverified.map((candidate) => ({
      code: 'VERIFICATION_MISSING',
      message: candidate.candidateId,
      candidateId: candidate.candidateId,
    })),
  ];
  const complete = reviewed === required && gaps.length === 0;
  return {
    formatVersion: 1,
    reviewKey: args.reviewKey,
    input: args.input,
    manifest: args.manifest,
    areasByUnit: args.areasByUnit,
    unitResults: reviews,
    verificationResults: verifications,
    attempts: [],
    gaps,
    coverage: {
      required,
      reviewed,
      reused: 0,
      skipped,
      failed,
      pending: required - reviewed - skipped - failed,
      complete,
      ratio: required === 0 ? null : reviewed / required,
      units: [],
    },
    completion: complete ? 'complete' : 'partial',
    outcome: complete ? (confirmed.length === 0 ? 'clean' : 'findings') : 'inconclusive',
    generatedAt: args.generatedAt,
  };
}

async function reviewWorkflow() {
  phase('review');
  const rawReviews = await parallel(
    args.manifest.units.map((unit) => () =>
      agent(reviewPrompt(unit.unitId), {
        agentType: args.agentType,
        allowedTools: args.stageTools,
        label: 'review:' + unit.unitId,
        schema: reviewSchema,
      }),
    ),
  );
  const reviews = args.manifest.units.map((unit, index) => normalizeReview(unit.unitId, rawReviews[index]));
  const candidates = collectCandidates(reviews);

  phase('verify');
  const rawVerifications = await parallel(
    candidates.map((candidate) => () =>
      agent(verifyPrompt(candidate), {
        agentType: args.agentType,
        allowedTools: args.stageTools,
        label: 'verify:' + candidate.candidateId,
        schema: verificationSchema,
      }),
    ),
  );
  const verifications = candidates.map((candidate, index) =>
    normalizeVerification(candidate, rawVerifications[index]),
  );

  phase('aggregate');
  return aggregate(reviews, verifications);
}

export const meta = {
  name: 'code-review-example',
  description: 'Review, verify and aggregate one fixed Git input',
};

export default await reviewWorkflow();
