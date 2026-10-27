// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
export { decodePrefix, isBinaryContent, splitContentLines } from './content.js';
export {
  buildAddDiff,
  buildBinaryAddDiff,
  parseUnifiedDiff,
  quoteGitPath,
  unquoteGitPath,
  type ChangeStatus,
  type DiffBlock,
  type DiffHunk,
} from './diff.js';
export { compileGlob, matchesAnyGlob, matchesGlob } from './glob.js';
export { canonicalHash, canonicalJson, digestBytes, digestLines, sha256Hex, shortHash } from './hash.js';
export { EMPTY_TREE_SHA, GitObjects, type StatusEntry, type TreeEntry } from './objects.js';
export { escapePathspec, isObjectId, isWithin, normalizeRepoPath, toFileSystemPath } from './paths.js';
export {
  DEFAULT_GIT_MAX_BUFFER_BYTES,
  DEFAULT_GIT_MAX_CONCURRENT,
  DEFAULT_GIT_TIMEOUT_MS,
  GIT_ENV_OVERRIDES,
  GIT_GLOBAL_ARGS,
  GitError,
  GitRunner,
  gitEnvironment,
  type GitFailureKind,
  type GitRunnerOptions,
  type GitSplitResult,
} from './runner.js';
