// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
import type {
  Coverage,
  ExportFormat,
  Location,
  ReportFinding,
  ReportModel,
  ReviewAttempt,
  ReviewGap,
} from '../domain/types.js';

export interface MarkdownDelivery {
  formats: readonly ExportFormat[];
  jsonDigest?: string;
}

/** Renders the human report from the same validated model as the JSON file. */
export function renderMarkdown(model: ReportModel, delivery: MarkdownDelivery): string {
  const lines: string[] = [];
  const push = (...values: string[]): void => {
    lines.push(...values);
  };

  push('# Code review report', '');
  push(`- Report: ${codeSpan(model.identity.reportId)}`);
  push(`- Workflow run: ${codeSpan(model.identity.workflowRunId)}`);
  push(`- Review key: ${codeSpan(model.identity.reviewKey)}`);
  push(`- Package version: ${codeSpan(model.identity.packageVersion)}`);
  push(`- Rules digest: ${codeSpan(model.identity.rulesDigest)}`);
  push(`- Skill digests: ${formatSkillDigests(model.identity.skillDigests)}`);
  push(`- Generated: ${model.generatedAt}`);
  push(`- Completion: **${model.completion}**`);
  push(`- Outcome: **${model.outcome}**`, '');

  renderSource(push, model);
  renderScope(push, model);
  renderCompletion(push, model.coverage, model);
  renderFindings(push, 'Confirmed findings', model.confirmed);
  renderFindings(push, 'Rejected findings', model.rejected);
  renderFindings(push, 'Unresolved findings', model.unresolved);
  renderRedundancy(push, model.confirmed);
  renderGaps(push, model.gaps);
  renderAttempts(push, model.attempts);
  renderDelivery(push, model, delivery);

  return `${lines.join('\n').trimEnd()}\n`;
}

function renderSource(push: (...values: string[]) => void, model: ReportModel): void {
  const source = model.source;
  push('## Source', '');
  push('| Repository | Mode | Base | Head | Comparison |');
  push('| - | - | - | - | - |');
  push(
    `| ${tableCell(source.repoId)} | ${codeSpan(source.mode)} | ${tableCell(source.baseSha)} | ${tableCell(source.headSha)} | ${codeSpan(source.comparison)} |`,
    '',
  );
  const refs = source.requestedRefs;
  if (refs !== undefined) {
    const parts: string[] = [];
    if (refs.from !== undefined) {
      parts.push(`from ${codeSpan(refs.from)}`);
    }
    if (refs.to !== undefined) {
      parts.push(`to ${codeSpan(refs.to)}`);
    }
    if (refs.commit !== undefined) {
      parts.push(`commit ${codeSpan(refs.commit)}`);
    }
    if (parts.length > 0) {
      push(`- Requested refs: ${parts.join(', ')}`);
    }
  }
  if (source.mergeBaseSha !== undefined) {
    push(`- Merge base: ${codeSpan(source.mergeBaseSha)}`);
  }
  if (source.workspaceFingerprint !== undefined) {
    push(`- Workspace fingerprint: ${codeSpan(source.workspaceFingerprint)}`);
  }
  push('');
}

function renderScope(push: (...values: string[]) => void, model: ReportModel): void {
  const scope = model.scope;
  push('## Scope', '');
  push(`- Include: ${formatPatterns(scope.include, 'all files')}`);
  push(`- Exclude: ${formatPatterns(scope.exclude, 'none')}`);
  push(`- Tests: ${scope.includeTests ? 'included' : 'excluded'}`);
  push(`- Deletions: ${scope.includeDeleted ? 'included' : 'excluded'}`);
  push(`- Manifest units: ${String(model.manifest.totalUnits)}`);
  push(`- Excluded paths: ${String(model.manifest.excluded.length)}`);
  push(`- Manifest digest: ${codeSpan(model.manifest.manifestDigest)}`, '');

  const withRules = model.manifest.units.filter((unit) => unit.ruleRefs.length > 0);
  if (withRules.length > 0) {
    push('### Rule areas', '');
    push('| Unit | Rule refs |');
    push('| - | - |');
    for (const unit of withRules) {
      const refs = unit.ruleRefs.map((ref) => `${ref.source}:${ref.pattern}`).join(', ');
      push(`| ${tableCell(unit.unitId)} | ${tableCell(refs)} |`);
    }
    push('');
  }

  push('### Coverage', '');
  push('| Required | Reviewed | Reused | Skipped | Failed | Pending | Complete | Ratio |');
  push('| - | - | - | - | - | - | - | - |');
  const coverage = model.coverage;
  push(
    `| ${String(coverage.required)} | ${String(coverage.reviewed)} | ${String(coverage.reused)} | ${String(coverage.skipped)} | ${String(coverage.failed)} | ${String(coverage.pending)} | ${String(coverage.complete)} | ${formatRatio(coverage)} |`,
    '',
  );

  if (coverage.units.length === 0) {
    push('_The selected range has no reviewable changes._', '');
  } else {
    push('| Unit | Kind | Paths | Status | Reason |');
    push('| - | - | - | - | - |');
    for (const unit of coverage.units) {
      const paths = unit.paths.length === 0 ? 'cross-file' : unit.paths.map(codeSpan).join('<br>');
      push(
        `| ${tableCell(unit.unitId)} | ${codeSpan(unit.kind)} | ${paths} | ${codeSpan(unit.status)} | ${unit.reason === undefined ? '-' : tableCell(unit.reason)} |`,
      );
    }
    push('');
  }

  push('### Excluded files', '');
  if (model.manifest.excluded.length === 0) {
    push('_No paths were excluded._', '');
  } else {
    for (const entry of model.manifest.excluded) {
      const side = entry.side === undefined ? '' : ` (${entry.side})`;
      const origin = entry.source === undefined ? '' : `, ${entry.source}`;
      push(`- ${codeSpan(entry.path)}${side}: ${entry.reason}${origin}`);
    }
    push('');
  }
}

function renderCompletion(
  push: (...values: string[]) => void,
  coverage: Coverage,
  model: ReportModel,
): void {
  push('## Completion', '');
  push('| Completion | Outcome | Reviewed | Confirmed | Unresolved |');
  push('| - | - | - | - | - |');
  push(
    `| ${codeSpan(model.completion)} | ${codeSpan(model.outcome)} | ${String(coverage.reviewed)}/${String(coverage.required)} | ${String(model.confirmed.length)} | ${String(model.unresolved.length)} |`,
    '',
  );
}

function renderFindings(
  push: (...values: string[]) => void,
  title: string,
  findings: ReportFinding[],
): void {
  push(`## ${title} (${String(findings.length)})`, '');
  if (findings.length === 0) {
    push('_None._', '');
    return;
  }
  for (const finding of findings) {
    const location = finding.location;
    push(
      `### [${finding.priority}] ${finding.category}: ${codeSpan(`${location.path}:${String(location.startLine)}-${String(location.endLine)}`)} — ${oneLine(finding.title)}`,
      '',
    );
    push(`- Candidate: ${codeSpan(finding.candidateId)} (unit ${codeSpan(finding.unitId)})`);
    push(`- Verdict: **${finding.verdict}**`);
    push(`- Trigger: ${oneLine(finding.trigger)}`);
    push(`- Impact: ${oneLine(finding.impact)}`);
    push(
      `- Location: ${codeSpan(location.path)} (${location.side}) lines ${String(location.startLine)}-${String(location.endLine)}`,
    );
    if (location.snippet.trim() !== '') {
      push('', fenced(location.snippet), '');
    }
    if (finding.evidence.length > 0) {
      push('', '- Evidence:');
      for (const evidence of finding.evidence) {
        push(`  - ${formatLocation(evidence)}`);
      }
      push('');
    }
    if (finding.verification !== undefined) {
      push(`- Verification: ${formatVerification(finding)}`);
      const verificationEvidence = finding.verification.evidence;
      if (verificationEvidence.length > 0) {
        push('', '- Verification evidence:');
        for (const evidence of verificationEvidence) {
          push(`  - ${formatLocation(evidence)}`);
        }
        push('');
      }
    }
    if (finding.originalPriority !== undefined) {
      push(
        `- Priority: ${finding.priority} (was ${finding.originalPriority})${finding.priorityChangeReason === undefined ? '' : `: ${oneLine(finding.priorityChangeReason)}`}`,
      );
    }
    push('');
  }
}

function renderRedundancy(push: (...values: string[]) => void, confirmed: ReportFinding[]): void {
  push('## Redundancy check', '');
  const risky = confirmed.filter((finding) => finding.category === 'redundancy');
  if (risky.length === 0) {
    push('_No risky redundancy findings were recorded._', '');
    return;
  }
  for (const finding of risky) {
    push(
      `- [${finding.priority}] ${oneLine(finding.title)}: ${oneLine(finding.impact)} (${codeSpan(`${finding.location.path}:${String(finding.location.startLine)}-${String(finding.location.endLine)}`)})`,
    );
  }
  push('');
}

function renderGaps(push: (...values: string[]) => void, gaps: ReviewGap[]): void {
  push('## Gaps', '');
  if (gaps.length === 0) {
    push('_No gaps were recorded._', '');
    return;
  }
  for (const gap of gaps) {
    const subject: string[] = [];
    if (gap.unitId !== undefined) {
      subject.push(`unit ${codeSpan(gap.unitId)}`);
    }
    if (gap.candidateId !== undefined) {
      subject.push(`candidate ${codeSpan(gap.candidateId)}`);
    }
    const suffix = subject.length === 0 ? '' : ` (${subject.join(', ')})`;
    push(`- ${codeSpan(gap.code)}: ${oneLine(gap.message)}${suffix}`);
  }
  push('');
}

function renderAttempts(push: (...values: string[]) => void, attempts: ReviewAttempt[]): void {
  push('## Process', '');
  if (attempts.length === 0) {
    push('_No stage attempts were recorded._', '');
    return;
  }
  push('| Stage | Attempt | Status | Unit | Candidate | Error |');
  push('| - | - | - | - | - | - |');
  for (const attempt of attempts) {
    const error = attempt.error === undefined ? '-' : tableCell(`${attempt.error.code}: ${attempt.error.message}`);
    push(
      `| ${codeSpan(attempt.stage)} | ${String(attempt.attempt)} | ${codeSpan(attempt.status)} | ${attempt.unitId === undefined ? '-' : tableCell(attempt.unitId)} | ${attempt.candidateId === undefined ? '-' : tableCell(attempt.candidateId)} | ${error} |`,
    );
  }
  push('');
}

function renderDelivery(
  push: (...values: string[]) => void,
  model: ReportModel,
  delivery: MarkdownDelivery,
): void {
  push('## Delivery', '');
  push(`- Generated: ${model.generatedAt}`);
  push(`- Formats: ${delivery.formats.map(codeSpan).join(', ')}`);
  if (delivery.jsonDigest !== undefined) {
    push(`- JSON digest: ${codeSpan(delivery.jsonDigest)}`);
  }
  push(
    `- Report files: ${delivery.formats
      .map((format) => codeSpan(`${model.identity.reportId}.${format === 'json' ? 'json' : 'md'}`))
      .join(', ')}`,
  );
  push('');
}

function formatSkillDigests(digests: Record<string, string>): string {
  const entries = Object.entries(digests);
  if (entries.length === 0) {
    return 'none';
  }
  return entries.map(([name, digest]) => `${codeSpan(name)}=${codeSpan(digest)}`).join(', ');
}

function formatPatterns(patterns: readonly string[], empty: string): string {
  return patterns.length === 0 ? empty : patterns.map(codeSpan).join(', ');
}

function formatRatio(coverage: Coverage): string {
  return coverage.ratio === null ? 'n/a' : coverage.ratio.toFixed(3);
}

function formatVerification(finding: ReportFinding): string {
  const verification = finding.verification;
  if (verification === undefined) {
    return 'none';
  }
  const reason = oneLine(verification.reason);
  return reason === '' ? 'recorded' : reason;
}

function formatLocation(location: Location): string {
  return `${codeSpan(location.path)} (${location.side}) lines ${String(location.startLine)}-${String(location.endLine)}`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

function tableCell(text: string): string {
  return codeSpan(oneLine(text)).replaceAll('|', '\\|');
}

function fenced(text: string): string {
  const content = text.replace(/\r\n/gu, '\n').replace(/\n$/u, '');
  const fence = '`'.repeat(Math.max(3, longestRun(content, '`') + 1));
  return `${fence}\n${content}\n${fence}`;
}

function codeSpan(text: string): string {
  const content = oneLine(text);
  const fence = '`'.repeat(Math.max(1, longestRun(content, '`') + 1));
  const pad = content.startsWith('`') || content.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${content}${pad}${fence}`;
}

function longestRun(text: string, character: string): number {
  let longest = 0;
  let current = 0;
  for (const value of text) {
    if (value === character) {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }
  return longest;
}
