// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { serveStdio, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { loadSkillCatalogSync, resolveAssetPath, skillDigestsFromCatalog } from '../assets.js';
import type {
  Candidate,
  Location,
  NormalizedReviewScope,
  ReviewRunResult,
  ReviewSource,
  ReviewUnit,
} from '../domain/types.js';
import { createRulesEngine } from '../rules/index.js';
import { SKILLS_EXTENSION_ID, createReviewMcpServer, type ReviewServerConfig } from './server.js';

const PROTOCOL_VERSION = '2026-07-28';
const SKILL_URIS = [
  'skill://project/review/SKILL.md',
  'skill://project/review-code/SKILL.md',
  'skill://project/review-verify/SKILL.md',
];
const EXAMPLE_URI = 'skill://project/review/example.js';

const BASE_SHA = '1111111111111111111111111111111111111111';
const HEAD_SHA = '2222222222222222222222222222222222222222';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

interface Session {
  client: Client;
  handle: StdioServerHandle;
  close(): Promise<void>;
}

async function connect(config: ReviewServerConfig): Promise<Session> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  // Use the real stdio entry so the modern era (server/discover) is installed
  // exactly as it is in production, instead of a hand-built McpServer.
  const handle = serveStdio(() => createReviewMcpServer(config), {
    legacy: 'reject',
    transport: serverTransport,
  });
  const client = new Client(
    { name: 'ocr-protocol-test', version: '0.0.0' },
    { versionNegotiation: { mode: { pin: PROTOCOL_VERSION } } },
  );
  await client.connect(clientTransport);
  return {
    client,
    handle,
    close: async () => {
      await client.close();
      await handle.close();
    },
  };
}

async function makeConfig(): Promise<ReviewServerConfig> {
  const root = await makeTempDir('ocr-mcp-');
  return {
    repoRoot: root,
    workflowRoot: join(root, 'runs'),
    outputDir: join(root, 'reports'),
    packageVersion: '9.9.9',
  };
}

function runGit(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      'git',
      [...args],
      { cwd, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', LANG: 'C' } },
      (error, stdout) => {
        if (error === null) {
          resolvePromise(stdout.trim());
        } else {
          reject(error);
        }
      },
    );
  });
}

async function writeFileAt(dir: string, path: string, content: string): Promise<void> {
  const target = join(dir, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
}

async function commit(dir: string, message: string): Promise<void> {
  await runGit(dir, ['add', '-A']);
  await runGit(dir, ['commit', '-q', '-m', message]);
}

async function initRepo(): Promise<{ dir: string; baseSha: string; headSha: string }> {
  const dir = await makeTempDir('ocr-mcp-repo-');
  await runGit(dir, ['init', '-q', '-b', 'main']);
  await runGit(dir, ['config', 'user.email', 'review@example.com']);
  await runGit(dir, ['config', 'user.name', 'Review Test']);
  await runGit(dir, ['config', 'commit.gpgsign', 'false']);
  await writeFileAt(dir, 'a.txt', 'one\ntwo\nthree\n');
  await writeFileAt(dir, 'c.txt', 'keep\n');
  await commit(dir, 'base');
  const baseSha = await runGit(dir, ['rev-parse', 'HEAD']);

  await runGit(dir, ['checkout', '-q', '-b', 'feature']);
  await writeFileAt(dir, 'a.txt', 'one\nTWO\nthree\n');
  await writeFileAt(dir, 'b.txt', 'hello world\n');
  await commit(dir, 'feature');
  const headSha = await runGit(dir, ['rev-parse', 'HEAD']);
  return { dir, baseSha, headSha };
}

interface PreparePage {
  source: {
    repoId: string;
    mode: string;
    baseSha: string;
    headSha: string;
    comparison: string;
  };
  units: { unitId: string }[];
  manifestDigest: string;
  totalUnits: number;
  rulesDigest: string;
  skillDigests: Record<string, string>;
  serverVersion: string;
  reviewKey: string;
  nextCursor?: string;
}

interface AreaPage {
  areasByUnit: { unitId: string; checks: unknown[]; rulesDigest: string; fallback?: boolean }[];
  nextCursor?: string;
}

function structured<T>(result: { structuredContent?: unknown }): T {
  return result.structuredContent as T;
}

function errorCode(result: { structuredContent?: unknown }): string {
  return structured<{ code: string }>(result).code;
}

const skillsListSchema = z.object({
  skills: z.array(
    z.object({
      uri: z.string(),
      frontmatter: z.record(z.string(), z.unknown()),
      resources: z.array(z.record(z.string(), z.unknown())),
    }),
  ),
});

const skillGetSchema = z.object({
  skill: z.object({
    uri: z.string(),
    frontmatter: z.record(z.string(), z.unknown()),
    resources: z.array(z.record(z.string(), z.unknown())),
  }),
});

describe('MCP protocol surface', () => {
  it('negotiates 2026-07-28 and advertises the skills extension', async () => {
    const session = await connect(await makeConfig());
    try {
      expect(session.client.getNegotiatedProtocolVersion()).toBe(PROTOCOL_VERSION);
      const capabilities = session.client.getServerCapabilities();
      expect(capabilities?.extensions?.[SKILLS_EXTENSION_ID]).toEqual({});
      expect(capabilities?.tools).toBeDefined();
      expect(capabilities?.resources).toBeDefined();
    } finally {
      await session.close();
    }
  });

  it('lists exactly the three business tools', async () => {
    const session = await connect(await makeConfig());
    try {
      const { tools } = await session.client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual([
        'export_code_review',
        'get_code_review_area',
        'prepare_code_review',
      ]);
      for (const tool of tools) {
        expect(tool.inputSchema).toBeDefined();
        expect(tool.outputSchema).toBeDefined();
      }
    } finally {
      await session.close();
    }
  });

  it('serves skills/list and skills/get without a size field', async () => {
    const session = await connect(await makeConfig());
    try {
      const listed = await session.client.request({ method: 'skills/list', params: {} }, skillsListSchema);
      expect(listed.skills.map((skill) => skill.uri).sort()).toEqual([...SKILL_URIS].sort());

      const digests = new Map<string, string>();
      for (const skill of listed.skills) {
        expect(skill.frontmatter.name).toBeTypeOf('string');
        expect(skill.frontmatter.description).toBeTypeOf('string');
        expect(skill.resources.some((resource) => resource.uri === skill.uri)).toBe(true);
        for (const resource of skill.resources) {
          expect(resource).not.toHaveProperty('size');
          expect(String(resource.digest)).toMatch(/^sha256:[0-9a-f]{64}$/);
          digests.set(String(resource.uri), String(resource.digest));
        }

        const fetched = await session.client.request(
          { method: 'skills/get', params: { uri: skill.uri } },
          skillGetSchema,
        );
        expect(fetched.skill).toEqual(skill);
      }
      expect(digests.has(EXAMPLE_URI)).toBe(true);

      await expect(
        session.client.request(
          { method: 'skills/get', params: { uri: 'skill://project/missing/SKILL.md' } },
          skillGetSchema,
        ),
      ).rejects.toMatchObject({ code: -32602 });

      await expect(
        session.client.request({ method: 'skills/list', params: { cursor: 'next-page' } }, skillsListSchema),
      ).rejects.toMatchObject({ code: -32602 });
    } finally {
      await session.close();
    }
  });

  it('lists four public resources, rejects agent:// and verifies digests on read', async () => {
    const session = await connect(await makeConfig());
    try {
      const listed = await session.client.request({ method: 'skills/list', params: {} }, skillsListSchema);
      const digests = new Map<string, string>(
        listed.skills.flatMap((skill) =>
          skill.resources.map((resource) => [String(resource.uri), String(resource.digest)] as const),
        ),
      );

      const { resources } = await session.client.listResources();
      const uris = resources.map((resource) => resource.uri);
      expect(uris.sort()).toEqual([...SKILL_URIS, EXAMPLE_URI].sort());
      expect(uris.some((uri) => uri.startsWith('agent://'))).toBe(false);

      for (const uri of uris) {
        const read = await session.client.readResource({ uri });
        const content = read.contents[0];
        expect(content).toBeDefined();
        expect(content !== undefined && 'text' in content).toBe(true);
        const text = content !== undefined && 'text' in content ? content.text : '';
        const digest = `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
        expect(digest).toBe(digests.get(uri));
      }
    } finally {
      await session.close();
    }
  });

  it('ships example.js as syntax-checked JavaScript', async () => {
    const examplePath = resolveAssetPath('workflow/example.js');
    await new Promise<void>((resolvePromise, reject) => {
      execFile(process.execPath, ['--check', examplePath], (error, _stdout, stderr) => {
        if (error === null) {
          resolvePromise();
          return;
        }
        reject(new Error(stderr === '' ? error.message : stderr));
      });
    });
    const text = await readFile(examplePath, 'utf8');
    expect(text).not.toMatch(/\b(?:interface|declare)\s/);
    expect(text).toContain('export const meta');
  });
});

describe('prepare_code_review and get_code_review_area', () => {
  it(
    'pages the manifest, keeps identity stable and matches checks',
    async () => {
      const repo = await initRepo();
      const config = { ...(await makeConfig()), repoRoot: repo.dir, pageSize: 1 };
      const session = await connect(config);
      try {
        const request = { input: { mode: 'range', from: 'main', to: 'feature' } };
        const units: PreparePage['units'] = [];
        let first: PreparePage | undefined;
        let cursor: string | undefined;

        do {
          const result = await session.client.callTool({
            name: 'prepare_code_review',
            arguments: { ...request, ...(cursor === undefined ? {} : { cursor }) },
          });
          expect(result.isError ?? false).toBe(false);
          const page = structured<PreparePage>(result);
          if (first === undefined) {
            first = page;
          } else {
            expect(page.manifestDigest).toBe(first.manifestDigest);
            expect(page.reviewKey).toBe(first.reviewKey);
          }
          units.push(...page.units);
          cursor = page.nextCursor;
          if (cursor !== undefined) {
            expect(page.units).toHaveLength(1);
          }
        } while (cursor !== undefined);

        expect(first).toBeDefined();
        const identity = first as PreparePage;
        expect(identity.totalUnits).toBe(3);
        expect(units).toHaveLength(3);
        expect(new Set(units.map((unit) => unit.unitId)).size).toBe(3);
        expect(identity.source).toMatchObject({
          mode: 'range',
          baseSha: repo.baseSha,
          headSha: repo.headSha,
          comparison: 'merge-base',
        });
        expect(identity.rulesDigest).toBe(createRulesEngine({ repoRoot: repo.dir }).rulesDigest);
        expect(identity.skillDigests).toEqual(skillDigestsFromCatalog(loadSkillCatalogSync()));
        expect(Object.keys(identity.skillDigests).sort()).toEqual(['review', 'review-code', 'review-verify']);
        expect(identity.serverVersion).toBe('9.9.9');

        const unitIds = units.map((unit) => unit.unitId);
        const areas: AreaPage['areasByUnit'] = [];
        let areaCursor: string | undefined;
        do {
          const result = await session.client.callTool({
            name: 'get_code_review_area',
            arguments: {
              source: identity.source,
              manifestDigest: identity.manifestDigest,
              rulesDigest: identity.rulesDigest,
              unitIds,
              ...(areaCursor === undefined ? {} : { cursor: areaCursor }),
            },
          });
          expect(result.isError ?? false).toBe(false);
          const page = structured<AreaPage>(result);
          areas.push(...page.areasByUnit);
          areaCursor = page.nextCursor;
          if (areaCursor !== undefined) {
            expect(page.areasByUnit).toHaveLength(1);
          }
        } while (areaCursor !== undefined);

        expect(areas).toHaveLength(3);
        expect(new Set(areas.map((area) => area.unitId))).toEqual(new Set(unitIds));
        for (const area of areas) {
          expect(area.rulesDigest).toBe(identity.rulesDigest);
          expect(area.checks.length).toBeGreaterThan(0);
        }

        const changed = await session.client.callTool({
          name: 'get_code_review_area',
          arguments: {
            source: identity.source,
            manifestDigest: `sha256:${'0'.repeat(64)}`,
            rulesDigest: identity.rulesDigest,
            unitIds,
          },
        });
        expect(changed.isError).toBe(true);
        expect(errorCode(changed)).toBe('SOURCE_CHANGED');

        const badCursor = await session.client.callTool({
          name: 'get_code_review_area',
          arguments: {
            source: identity.source,
            manifestDigest: identity.manifestDigest,
            rulesDigest: identity.rulesDigest,
            unitIds,
            cursor: 'not-a-cursor',
          },
        });
        expect(badCursor.isError).toBe(true);
        expect(errorCode(badCursor)).toBe('INVALID_CURSOR');

        const badPrepareCursor = await session.client.callTool({
          name: 'prepare_code_review',
          arguments: { ...request, cursor: 'not-a-cursor' },
        });
        expect(badPrepareCursor.isError).toBe(true);
        expect(errorCode(badPrepareCursor)).toBe('INVALID_CURSOR');
      } finally {
        await session.close();
      }
    },
    60_000,
  );
});

function makeRunResult(overrides: Partial<ReviewRunResult> = {}): ReviewRunResult {
  const input = { mode: 'range' as const, from: 'main', to: 'feature' };
  const check = { checkId: 'chk_1', ruleId: 'system:logic', text: 'Check the logic.' };
  return {
    formatVersion: 1,
    reviewKey: 'rk-1',
    input,
    manifest: {
      reviewKey: 'rk-1',
      input,
      source: {
        repoId: 'repo-1',
        mode: 'range',
        requestedRefs: { from: 'main', to: 'feature' },
        baseSha: BASE_SHA,
        headSha: HEAD_SHA,
        mergeBaseSha: BASE_SHA,
        comparison: 'merge-base',
      },
      scope: { include: [], exclude: [], includeTests: true, includeDeleted: true },
      units: [
        {
          unitId: 'u1',
          kind: 'file',
          changeIds: ['ch-1'],
          paths: ['src/a.ts'],
          relatedPaths: [],
          side: 'head',
          startLine: 1,
          endLine: 10,
          slices: [{ hunkIndex: 0, start: 1, end: 10 }],
          fullFile: false,
          ruleRefs: [{ source: 'system', pattern: '**/*.ts' }],
          status: 'pending',
        },
      ],
      excluded: [],
      manifestDigest: 'sha256:manifest',
      totalUnits: 1,
      rulesDigest: 'sha256:rules',
      skillDigests: { review: 'sha256:skill' },
      serverVersion: '0.1.0',
    },
    areasByUnit: [{ unitId: 'u1', areas: ['logic'], checks: [check], ruleIds: ['system:logic'], rulesDigest: 'sha256:rules' }],
    unitResults: [
      {
        unitId: 'u1',
        reviewKey: 'rk-1',
        status: 'reviewed',
        checkedCheckIds: ['chk_1'],
        notApplicable: [],
        candidates: [],
      },
    ],
    verificationResults: [],
    attempts: [],
    gaps: [],
    coverage: {
      required: 1,
      reviewed: 1,
      reused: 0,
      skipped: 0,
      failed: 0,
      pending: 0,
      complete: true,
      ratio: 1,
      units: [],
    },
    ...overrides,
  };
}

function makeState(runId: string, result: ReviewRunResult): Record<string, unknown> {
  return {
    run_id: runId,
    workflow_name: 'code-review',
    status: 'completed',
    execution_status: 'completed',
    acceptance_status: 'unknown',
    post_processing_status: 'not_required',
    delivery_status: 'unknown',
    attempts: [],
    return_value: result,
    script: 'export const meta = {}',
    started_at: '2026-10-27T00:00:00.000Z',
    finished_at: '2026-10-27T00:01:00.000Z',
  };
}

async function writeRun(root: string, runId: string, result: ReviewRunResult): Promise<void> {
  const runDir = join(root, runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, 'state.json'), JSON.stringify(makeState(runId, result), null, 2));
}

interface PreparedRangePage extends PreparePage {
  source: ReviewSource;
  scope: NormalizedReviewScope;
  units: ReviewUnit[];
}

async function prepareRangePage(session: Session): Promise<PreparedRangePage> {
  const prepared = await session.client.callTool({
    name: 'prepare_code_review',
    arguments: { input: { mode: 'range', from: 'main', to: 'feature' } },
  });
  expect(prepared.isError ?? false).toBe(false);
  return structured<PreparedRangePage>(prepared);
}

/** Binds one confirmed candidate to the real prepared manifest and source. */
function makePreparedFindingRun(
  page: PreparedRangePage,
  location: Location,
): { result: ReviewRunResult; candidate: Candidate } {
  const unit = page.units.find((entry) => entry.paths.includes(location.path));
  if (unit === undefined) {
    throw new Error(`no prepared unit covers ${location.path}`);
  }
  const reviewKey = page.reviewKey;
  const input = { mode: 'range' as const, from: 'main', to: 'feature' };
  const candidate: Candidate = {
    candidateId: 'cand-1',
    unitId: unit.unitId,
    category: 'correctness',
    priority: 'P1',
    title: 'Value is returned before the validation runs',
    trigger: 'read the value through the new path',
    impact: 'callers observe an unvalidated value',
    location,
    evidence: [],
  };
  return {
    candidate,
    result: {
      formatVersion: 1,
      reviewKey,
      input,
      manifest: {
        reviewKey,
        input,
        source: page.source,
        scope: page.scope,
        units: page.units,
        excluded: [],
        manifestDigest: page.manifestDigest,
        totalUnits: page.totalUnits,
        rulesDigest: page.rulesDigest,
        skillDigests: page.skillDigests,
        serverVersion: page.serverVersion,
      },
      areasByUnit: page.units.map((entry) => ({
        unitId: entry.unitId,
        areas: [],
        checks: [],
        ruleIds: [],
        rulesDigest: page.rulesDigest,
      })),
      unitResults: page.units.map((entry) => ({
        unitId: entry.unitId,
        reviewKey,
        status: 'reviewed',
        checkedCheckIds: [],
        notApplicable: [],
        candidates: entry.unitId === unit.unitId ? [candidate] : [],
      })),
      verificationResults: [
        {
          candidateId: candidate.candidateId,
          reviewKey,
          verdict: 'confirmed',
          reason: 'reproduced by reading the fixed head revision',
          evidence: [],
        },
      ],
      attempts: [],
      gaps: [],
      coverage: {
        required: page.totalUnits,
        reviewed: page.totalUnits,
        reused: 0,
        skipped: 0,
        failed: 0,
        pending: 0,
        complete: true,
        ratio: page.totalUnits === 0 ? null : 1,
        units: [],
      },
    },
  };
}

describe('export_code_review evidence revalidation', () => {
  it('exports a finding whose location resolves in the fixed Git source', async () => {
    const repo = await initRepo();
    const config = { ...(await makeConfig()), repoRoot: repo.dir };
    const session = await connect(config);
    try {
      const page = await prepareRangePage(session);
      const { result } = makePreparedFindingRun(page, {
        path: 'b.txt',
        side: 'head',
        startLine: 1,
        endLine: 1,
        snippet: 'hello world',
      });
      await writeRun(config.workflowRoot, 'run-located', result);

      const exported = await session.client.callTool({
        name: 'export_code_review',
        arguments: { workflowRunId: 'run-located', formats: ['json'] },
      });
      expect(exported.isError ?? false).toBe(false);
      const output = structured<{ outcome: string; findings: { total: number } }>(exported);
      expect(output.outcome).toBe('findings');
      expect(output.findings.total).toBe(1);
    } finally {
      await session.close();
    }
  }, 60_000);

  it('rejects a finding whose line range does not resolve and writes no report', async () => {
    const repo = await initRepo();
    const config = { ...(await makeConfig()), repoRoot: repo.dir };
    const session = await connect(config);
    try {
      const page = await prepareRangePage(session);
      const { result } = makePreparedFindingRun(page, {
        path: 'b.txt',
        side: 'head',
        startLine: 4,
        endLine: 4,
        snippet: 'this line is not in the fixed source',
      });
      await writeRun(config.workflowRoot, 'run-unlocated', result);

      const exported = await session.client.callTool({
        name: 'export_code_review',
        arguments: { workflowRunId: 'run-unlocated', formats: ['json', 'markdown'] },
      });
      expect(exported.isError).toBe(true);
      expect(errorCode(exported)).toBe('INVALID_FINDING');
      const payload = structured<{
        details: {
          failures: {
            candidateId: string;
            role: string;
            path: string;
            side: string;
            reason: string;
            note: string;
          }[];
        };
      }>(exported);
      expect(payload.details.failures).toHaveLength(1);
      expect(payload.details.failures[0]).toMatchObject({
        candidateId: 'cand-1',
        role: 'location',
        path: 'b.txt',
        side: 'head',
        reason: 'unlocated',
      });
      expect(payload.details.failures[0]?.note).toContain('snippet not found');
      await expect(readdir(config.outputDir)).rejects.toThrow();
    } finally {
      await session.close();
    }
  }, 60_000);
});

describe('export_code_review', () => {
  it('exports a complete synthesized workflow run and reports file digests', async () => {
    const config = await makeConfig();
    await writeRun(config.workflowRoot, 'run-complete', makeRunResult());
    const session = await connect(config);
    try {
      const result = await session.client.callTool({
        name: 'export_code_review',
        arguments: { workflowRunId: 'run-complete', formats: ['json', 'markdown'] },
      });
      expect(result.isError ?? false).toBe(false);
      const output = structured<{
        status: string;
        workflowRunId: string;
        reportId: string;
        completion: string;
        outcome: string;
        coverage: { complete: boolean; ratio: number | null };
        files: { format: string; path: string; digest: string }[];
      }>(result);
      expect(output.status).toBe('exported');
      expect(output.workflowRunId).toBe('run-complete');
      expect(output.completion).toBe('complete');
      expect(output.outcome).toBe('clean');
      expect(output.coverage).toMatchObject({ complete: true, ratio: 1 });
      expect(output.files.map((file) => file.format).sort()).toEqual(['json', 'markdown']);

      for (const file of output.files) {
        const text = await readFile(file.path, 'utf8');
        expect(text.length).toBeGreaterThan(0);
        expect(`sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`).toBe(file.digest);
      }
    } finally {
      await session.close();
    }
  });

  it('requires allowPartial for gaps and marks a partial report', async () => {
    const config = await makeConfig();
    await writeRun(config.workflowRoot, 'run-partial', makeRunResult({ unitResults: [] }));
    const session = await connect(config);
    try {
      const rejected = await session.client.callTool({
        name: 'export_code_review',
        arguments: { workflowRunId: 'run-partial', formats: ['json'] },
      });
      expect(rejected.isError).toBe(true);
      expect(errorCode(rejected)).toBe('INCOMPLETE_COVERAGE');

      const partial = await session.client.callTool({
        name: 'export_code_review',
        arguments: { workflowRunId: 'run-partial', formats: ['json'], allowPartial: true },
      });
      expect(partial.isError ?? false).toBe(false);
      const output = structured<{ status: string; completion: string; outcome: string }>(partial);
      expect(output.status).toBe('partial');
      expect(output.completion).toBe('partial');
      expect(output.outcome).toBe('inconclusive');
    } finally {
      await session.close();
    }
  });

  it('reports RUN_NOT_FOUND for an unknown workflow run', async () => {
    const config = await makeConfig();
    await mkdir(config.workflowRoot, { recursive: true });
    const session = await connect(config);
    try {
      const result = await session.client.callTool({
        name: 'export_code_review',
        arguments: { workflowRunId: 'missing-run', formats: ['json'] },
      });
      expect(result.isError).toBe(true);
      expect(errorCode(result)).toBe('RUN_NOT_FOUND');
    } finally {
      await session.close();
    }
  });
});
