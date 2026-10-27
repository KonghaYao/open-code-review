// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
import { ReviewError } from '../domain/errors.js';
import type { ReportBuilder, ReportBuildContext } from '../domain/interfaces.js';
import type {
  ExportCodeReviewInput,
  ExportCodeReviewOutput,
  ReviewRunResult,
} from '../domain/types.js';
import { digestBytes } from '../git/hash.js';
import { resolveOutputDir, writeReportFiles, type ReportFileRequest } from './files.js';
import { renderMarkdown } from './markdown.js';
import { assignReportId, buildReportModel, evaluateRun } from './model.js';
import { validateExportInput, validateReviewRunResult } from './validate.js';

/**
 * Deterministic report exporter. It revalidates the recovered run, recomputes
 * coverage and completion, renders one ReportModel to JSON and Markdown, and
 * writes both formats atomically under the configured output directory.
 */
export class FileReportBuilder implements ReportBuilder {
  async exportReport(
    input: ExportCodeReviewInput,
    result: ReviewRunResult,
    context: ReportBuildContext,
  ): Promise<ExportCodeReviewOutput> {
    validateExportInput(input);
    validateContext(context, input);
    validateReviewRunResult(result, { expectedWorkflowRunId: context.workflowRunId });

    if (result.workflowRunId !== undefined && result.workflowRunId !== context.workflowRunId) {
      throw new ReviewError('INVALID_INPUT', 'review result belongs to another workflow run', {
        details: { expectedWorkflowRunId: context.workflowRunId, workflowRunId: result.workflowRunId },
      });
    }

    const evaluation = evaluateRun(result);
    if (evaluation.completion !== 'complete' && input.allowPartial !== true) {
      throw new ReviewError('INCOMPLETE_COVERAGE', 'the run has coverage gaps or unresolved findings', {
        details: {
          completion: evaluation.completion,
          outcome: evaluation.outcome,
          coverage: evaluation.coverage,
          gaps: evaluation.gaps,
        },
      });
    }

    const outputDir = await resolveOutputDir(context.outputDir);
    const model = buildReportModel({
      result,
      workflowRunId: context.workflowRunId,
      packageVersion: context.packageVersion,
      generatedAt: context.generatedAt,
      evaluation,
    });
    const reportId = assignReportId(model);

    const json = JSON.stringify(model, null, 2) + '\n';
    const jsonDigest = input.formats.includes('json') ? digestBytes(json) : undefined;
    const markdown = input.formats.includes('markdown')
      ? renderMarkdown(model, {
          formats: input.formats,
          ...(jsonDigest === undefined ? {} : { jsonDigest }),
        })
      : '';
    const requests: ReportFileRequest[] = input.formats.map((format) => ({
      format,
      content: format === 'json' ? json : markdown,
    }));

    const files = await writeReportFiles(outputDir, reportId, requests);
    return {
      status: evaluation.completion === 'complete' ? 'exported' : 'partial',
      workflowRunId: context.workflowRunId,
      reportId,
      reviewKey: result.reviewKey,
      completion: evaluation.completion,
      outcome: evaluation.outcome,
      coverage: evaluation.coverage,
      findings: evaluation.findings,
      files,
      gaps: evaluation.gaps,
      generatedAt: context.generatedAt,
    };
  }
}

function validateContext(context: ReportBuildContext, input: ExportCodeReviewInput): void {
  if (context.workflowRunId !== input.workflowRunId) {
    throw new ReviewError('INVALID_INPUT', 'export request and report context disagree on the workflow run', {
      details: { request: input.workflowRunId, context: context.workflowRunId },
    });
  }
  if (typeof context.outputDir !== 'string' || context.outputDir.trim() === '') {
    throw new ReviewError('INVALID_INPUT', 'outputDir is required');
  }
  if (typeof context.packageVersion !== 'string' || context.packageVersion.trim() === '') {
    throw new ReviewError('INVALID_INPUT', 'packageVersion is required');
  }
  if (typeof context.generatedAt !== 'string' || Number.isNaN(Date.parse(context.generatedAt))) {
    throw new ReviewError('INVALID_INPUT', 'generatedAt must be an ISO timestamp');
  }
}

export function createReportBuilder(): ReportBuilder {
  return new FileReportBuilder();
}

/** Compatibility alias for the scaffold export. */
export const PlaceholderReportBuilder = FileReportBuilder;
