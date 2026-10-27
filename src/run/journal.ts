// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
import { lstat, open, realpath } from 'node:fs/promises';
import { join } from 'node:path';

import { isWithin } from '../git/paths.js';

const AGENT_KINDS = new Set(['ok', 'skipped', 'dead']);

/** Read-only summary of the engine journal, used only in failure details. */
export interface JournalNotes {
  entries: number;
  ok: number;
  skipped: number;
  dead: number;
  invalidLines: number;
  phases: string[];
  truncated: boolean;
  last?: {
    kind: string;
    phase?: string;
    reason?: string;
    detail?: string;
  };
}

/**
 * Summarizes journal.jsonl without treating it as a run result. Journal entries
 * prove that agents ran; they never prove that the workflow returned a
 * complete, acceptable result.
 */
export async function readJournalNotes(runDir: string, maxBytes: number): Promise<JournalNotes | undefined> {
  try {
    const path = join(runDir, 'journal.jsonl');
    const stats = await lstat(path);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      return undefined;
    }
    const real = await realpath(path);
    if (!isWithin(runDir, real)) {
      return undefined;
    }

    const limit = Math.min(stats.size, maxBytes);
    const buffer = Buffer.alloc(limit);
    const handle = await open(real, 'r');
    try {
      await handle.read(buffer, 0, limit, 0);
    } finally {
      await handle.close();
    }
    let text = buffer.toString('utf8');
    const truncated = stats.size > maxBytes;
    if (truncated) {
      const lastNewline = text.lastIndexOf('\n');
      text = lastNewline < 0 ? '' : text.slice(0, lastNewline);
    }

    const notes: JournalNotes = {
      entries: 0,
      ok: 0,
      skipped: 0,
      dead: 0,
      invalidLines: 0,
      phases: [],
      truncated,
    };
    const phases = new Set<string>();
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') {
        continue;
      }
      const entry = parseEntry(trimmed);
      if (entry === undefined) {
        notes.invalidLines += 1;
        continue;
      }
      notes.entries += 1;
      notes[entry.kind] += 1;
      if (entry.phase !== undefined && !phases.has(entry.phase)) {
        phases.add(entry.phase);
        notes.phases.push(entry.phase);
      }
      notes.last = {
        kind: entry.kind,
        ...(entry.phase === undefined ? {} : { phase: entry.phase }),
        ...(entry.reason === undefined ? {} : { reason: entry.reason }),
        ...(entry.detail === undefined ? {} : { detail: entry.detail }),
      };
    }
    return notes;
  } catch {
    return undefined;
  }
}

interface ParsedEntry {
  kind: 'ok' | 'skipped' | 'dead';
  phase?: string;
  reason?: string;
  detail?: string;
}

function parseEntry(line: string): ParsedEntry | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined;
  }
  const entry = parsed as { result?: unknown };
  if (entry.result === null || typeof entry.result !== 'object' || Array.isArray(entry.result)) {
    return undefined;
  }
  const result = entry.result as Record<string, unknown>;
  const kind = result.kind === undefined ? 'ok' : result.kind;
  if (typeof kind !== 'string' || !AGENT_KINDS.has(kind)) {
    return undefined;
  }
  return {
    kind: kind as ParsedEntry['kind'],
    ...(typeof result.phase === 'string' ? { phase: result.phase } : {}),
    ...(typeof result.reason === 'string' ? { reason: result.reason } : {}),
    ...(typeof result.detail === 'string' ? { detail: result.detail } : {}),
  };
}
