// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
/** Stable business error codes shared by tools, validators and exporters. */
export const REVIEW_ERROR_CODES = [
  'INVALID_INPUT',
  'INVALID_CURSOR',
  'SOURCE_CHANGED',
  'POLICY_CHANGED',
  'INCOMPLETE_COVERAGE',
  'INVALID_FINDING',
  'INVALID_ANCHOR',
  'RUN_NOT_FOUND',
  'RUN_NOT_EXPORTABLE',
  'UNSUPPORTED_RUN_FORMAT',
  'OUTPUT_CONFLICT',
  'PREPARATION_FAILED',
  'PAYLOAD_TOO_LARGE',
  'BINARY_FILE',
  'ASSET_NOT_FOUND',
  'NOT_IMPLEMENTED',
  'INTERNAL_ERROR',
] as const;

export type ReviewErrorCode = (typeof REVIEW_ERROR_CODES)[number];

export interface ReviewErrorPayload {
  code: ReviewErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export class ReviewError extends Error {
  readonly code: ReviewErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: ReviewErrorCode, message: string, options?: { details?: Record<string, unknown>; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ReviewError';
    this.code = code;
    this.details = options?.details;
  }

  toJSON(): ReviewErrorPayload {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details };
  }
}

export function isReviewError(error: unknown): error is ReviewError {
  return error instanceof ReviewError;
}

/** Converts unknown failures into a serializable structured error. */
export function normalizeError(error: unknown): ReviewError {
  if (isReviewError(error)) {
    return error;
  }
  if (error instanceof Error) {
    return new ReviewError('INTERNAL_ERROR', error.message, { cause: error });
  }
  return new ReviewError('INTERNAL_ERROR', String(error));
}

export function notImplemented(feature: string): ReviewError {
  return new ReviewError('NOT_IMPLEMENTED', `${feature} is not implemented yet`);
}
