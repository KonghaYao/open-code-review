// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
import type { RunStateStore } from '../domain/interfaces.js';
import { WorkflowRunStateStore, type RunStateStoreOptions } from './store.js';

export { WorkflowRunStateStore };
export type { RunStateStoreOptions };
export type { JournalNotes } from './journal.js';

export function createRunStateStore(workflowRoot: string, options?: RunStateStoreOptions): RunStateStore {
  return new WorkflowRunStateStore(workflowRoot, options);
}

/** Compatibility alias for the scaffold export. */
export const PlaceholderRunStateStore = WorkflowRunStateStore;
