// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors

package reviewcore

import (
	"errors"
	"fmt"
)

// ErrorCode is a stable, machine-readable business error code. Clients must
// branch on the code rather than parsing the message.
type ErrorCode string

const (
	CodeInvalidArgument         ErrorCode = "INVALID_ARGUMENT"
	CodeInvalidInput            ErrorCode = "INVALID_INPUT"
	CodeInputChanged            ErrorCode = "INPUT_CHANGED"
	CodeSnapshotMissing         ErrorCode = "SNAPSHOT_MISSING"
	CodeInvalidAnchor           ErrorCode = "INVALID_ANCHOR"
	CodePayloadTooLarge         ErrorCode = "PAYLOAD_TOO_LARGE"
	CodeIdempotencyConflict     ErrorCode = "IDEMPOTENCY_CONFLICT"
	CodeRevisionConflict        ErrorCode = "REVISION_CONFLICT"
	CodeRunSealed               ErrorCode = "RUN_SEALED"
	CodeReviewIncomplete        ErrorCode = "REVIEW_INCOMPLETE"
	CodePreparationLimit        ErrorCode = "PREPARATION_LIMIT"
	CodePreparationFailed       ErrorCode = "PREPARATION_FAILED"
	CodeExecutionTimeout        ErrorCode = "EXECUTION_TIMEOUT"
	CodeRunNotFound             ErrorCode = "RUN_NOT_FOUND"
	CodeStateCorrupt            ErrorCode = "STATE_CORRUPT"
	CodeStateVersionUnsupported ErrorCode = "STATE_VERSION_UNSUPPORTED"
	CodeInvalidCursor           ErrorCode = "INVALID_CURSOR"
	CodePathOutOfScope          ErrorCode = "PATH_OUT_OF_SCOPE"
	CodeSecretPath              ErrorCode = "SECRET_PATH"
	CodeBinaryFile              ErrorCode = "BINARY_FILE"
	CodeGitFailure              ErrorCode = "GIT_FAILURE"
	CodeInternal                ErrorCode = "INTERNAL"
)

// Error is a business error returned to the MCP client. It never contains
// credentials or raw repository paths.
type Error struct {
	Code    ErrorCode `json:"code"`
	Message string    `json:"message"`
	Details any       `json:"details,omitempty"`
}

func (e *Error) Error() string { return string(e.Code) + ": " + e.Message }

// WithDetails returns a copy carrying structured, client-safe details.
func (e *Error) WithDetails(details any) *Error {
	clone := *e
	clone.Details = details
	return &clone
}

// Errorf builds a business error.
func Errorf(code ErrorCode, format string, args ...any) *Error {
	return &Error{Code: code, Message: fmt.Sprintf(format, args...)}
}

// AsError maps any error to a business error. Unknown errors become INTERNAL
// with their message preserved, because callers deliberately wrap safe text.
func AsError(err error) *Error {
	if err == nil {
		return nil
	}
	var business *Error
	if errors.As(err, &business) {
		return business
	}
	return &Error{Code: CodeInternal, Message: err.Error()}
}

// IsCode reports whether err carries the given business code.
func IsCode(err error, code ErrorCode) bool {
	var business *Error
	return errors.As(err, &business) && business.Code == code
}
