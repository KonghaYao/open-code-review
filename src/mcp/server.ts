// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
import { Buffer } from 'node:buffer';

import { McpServer, ProtocolError, ProtocolErrorCode, type CallToolResult } from '@modelcontextprotocol/server';
import { z } from 'zod';

import {
  PUBLIC_RESOURCES,
  getPackageInfo,
  loadSkillCatalogSync,
  readPublicResourceText,
  resourceDigestsFromCatalog,
  skillDigestsFromCatalog,
  type SkillCatalog,
} from '../assets.js';
import { ReviewError, normalizeError } from '../domain/errors.js';
import type { ReviewServices } from '../domain/interfaces.js';
import type {
  ExportCodeReviewInput,
  GetCodeReviewAreaInput,
  PrepareCodeReviewInput,
} from '../domain/types.js';
import {
  ATTEMPT_STATUSES,
  CATEGORIES,
  CHANGE_SIDES,
  COMPARISONS,
  COMPLETIONS,
  EXCLUSION_REASONS,
  EXPORT_FORMATS,
  EXPORT_STATUSES,
  OUTCOMES,
  PRIORITIES,
  REVIEW_MODES,
  UNIT_KINDS,
  UNIT_RESULT_STATUSES,
  UNIT_STATUSES,
  VERDICTS,
} from '../domain/types.js';
import { canonicalHash } from '../git/hash.js';
import { createRepository, createReader } from '../repository/index.js';
import type { RepositoryOptions } from '../repository/options.js';
import { createReportBuilder } from '../report/index.js';
import { createRulesEngine } from '../rules/index.js';
import { createRunStateStore } from '../run/index.js';
import { verifyFindingEvidence } from './evidence.js';

/** The modern revision must be listed explicitly or server/discover is not installed. */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'] as const;

export const SKILLS_EXTENSION_ID = 'io.modelcontextprotocol/skills';
export const SKILLS_LIST_METHOD = 'skills/list';
export const SKILLS_GET_METHOD = 'skills/get';

const reviewInputSchema = z.object({
  mode: z.enum(REVIEW_MODES),
  from: z.string().min(1).optional(),
  to: z.string().min(1).optional(),
  commit: z.string().min(1).optional(),
});

const requestedRefsSchema = z.object({
  from: z.string().min(1).optional(),
  to: z.string().min(1).optional(),
  commit: z.string().min(1).optional(),
});

const reviewSourceSchema = z.object({
  repoId: z.string().min(1),
  mode: z.enum(REVIEW_MODES),
  requestedRefs: requestedRefsSchema.optional(),
  baseSha: z.string(),
  headSha: z.string(),
  mergeBaseSha: z.string().min(1).optional(),
  comparison: z.enum(COMPARISONS),
  workspaceFingerprint: z.string().min(1).optional(),
});

const reviewScopeSchema = z.object({
  include: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
  includeTests: z.boolean().optional(),
  includeDeleted: z.boolean().optional(),
});

const normalizedScopeSchema = z.object({
  include: z.array(z.string()),
  exclude: z.array(z.string()),
  includeTests: z.boolean(),
  includeDeleted: z.boolean(),
});

const diffSliceSchema = z.object({
  hunkIndex: z.number().int().nonnegative(),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
});

const ruleRefSchema = z.object({
  source: z.enum(['system', 'project']),
  pattern: z.string(),
});

const reviewUnitSchema = z.object({
  unitId: z.string().min(1),
  kind: z.enum(UNIT_KINDS),
  changeIds: z.array(z.string().min(1)),
  paths: z.array(z.string()),
  relatedPaths: z.array(z.string()),
  side: z.enum(CHANGE_SIDES),
  startLine: z.number().int().nonnegative(),
  endLine: z.number().int().nonnegative(),
  slices: z.array(diffSliceSchema),
  fullFile: z.boolean(),
  ruleRefs: z.array(ruleRefSchema),
  status: z.enum(UNIT_STATUSES),
  reason: z.string().optional(),
});

const excludedPathSchema = z.object({
  path: z.string(),
  side: z.enum(CHANGE_SIDES).optional(),
  reason: z.enum(EXCLUSION_REASONS),
  source: z.string().optional(),
});

const reviewCheckSchema = z.object({
  checkId: z.string().min(1),
  ruleId: z.string().min(1),
  text: z.string(),
});

const unitReviewAreaSchema = z.object({
  unitId: z.string().min(1),
  areas: z.array(z.string()),
  checks: z.array(reviewCheckSchema),
  ruleIds: z.array(z.string()),
  rulesDigest: z.string().min(1),
  fallback: z.boolean().optional(),
});

const locationSchema = z.object({
  path: z.string().min(1),
  side: z.enum(CHANGE_SIDES),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  snippet: z.string(),
});

const candidateSchema = z.object({
  candidateId: z.string().min(1),
  unitId: z.string().min(1),
  category: z.enum(CATEGORIES),
  priority: z.enum(PRIORITIES),
  title: z.string().min(1),
  trigger: z.string().min(1),
  impact: z.string().min(1),
  location: locationSchema,
  evidence: z.array(locationSchema),
});

const unitResultSchema = z.object({
  unitId: z.string().min(1),
  reviewKey: z.string().min(1),
  status: z.enum(UNIT_RESULT_STATUSES),
  checkedCheckIds: z.array(z.string()),
  notApplicable: z.array(z.object({ checkId: z.string().min(1), reason: z.string() })),
  candidates: z.array(candidateSchema),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});

const verificationResultSchema = z.object({
  candidateId: z.string().min(1),
  reviewKey: z.string().min(1),
  verdict: z.enum(VERDICTS),
  reason: z.string(),
  evidence: z.array(locationSchema),
  suggestedPriority: z.enum(PRIORITIES).optional(),
});

const coverageUnitSchema = z.object({
  unitId: z.string().min(1),
  kind: z.enum(UNIT_KINDS),
  paths: z.array(z.string()),
  status: z.enum(UNIT_STATUSES),
  reason: z.string().optional(),
  reused: z.boolean().optional(),
});

const coverageSchema = z.object({
  required: z.number().int().nonnegative(),
  reviewed: z.number().int().nonnegative(),
  reused: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  complete: z.boolean(),
  ratio: z.number().min(0).max(1).nullable(),
  units: z.array(coverageUnitSchema),
});

const reviewGapSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  unitId: z.string().optional(),
  candidateId: z.string().optional(),
});

const reviewAttemptSchema = z.object({
  stage: z.enum(['review', 'verify', 'aggregate']),
  attempt: z.number().int().positive(),
  status: z.enum(ATTEMPT_STATUSES),
  unitId: z.string().optional(),
  candidateId: z.string().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});

const reviewManifestSchema = z.object({
  reviewKey: z.string().min(1),
  input: reviewInputSchema,
  source: reviewSourceSchema,
  scope: normalizedScopeSchema,
  units: z.array(reviewUnitSchema),
  excluded: z.array(excludedPathSchema),
  manifestDigest: z.string().min(1),
  totalUnits: z.number().int().nonnegative(),
  rulesDigest: z.string().min(1),
  skillDigests: z.record(z.string(), z.string()),
  serverVersion: z.string().min(1),
});

export const PrepareCodeReviewInputSchema = z.object({
  input: reviewInputSchema,
  scope: reviewScopeSchema.optional(),
  background: z.string().optional(),
  cursor: z.string().min(1).optional(),
});

export const PrepareCodeReviewOutputSchema = z.object({
  source: reviewSourceSchema,
  scope: normalizedScopeSchema,
  background: z.string().optional(),
  units: z.array(reviewUnitSchema),
  excluded: z.array(excludedPathSchema),
  manifestDigest: z.string().min(1),
  totalUnits: z.number().int().nonnegative(),
  rulesDigest: z.string().min(1),
  skillDigests: z.record(z.string(), z.string()),
  serverVersion: z.string().min(1),
  reviewKey: z.string().min(1),
  nextCursor: z.string().min(1).optional(),
});

export const GetCodeReviewAreaInputSchema = z.object({
  source: reviewSourceSchema,
  manifestDigest: z.string().min(1),
  unitIds: z.array(z.string().min(1)).min(1),
  rulesDigest: z.string().min(1),
  input: reviewInputSchema.optional(),
  scope: reviewScopeSchema.optional(),
  cursor: z.string().min(1).optional(),
});

export const GetCodeReviewAreaOutputSchema = z.object({
  areasByUnit: z.array(unitReviewAreaSchema),
  nextCursor: z.string().min(1).optional(),
});

export const ExportCodeReviewInputSchema = z.object({
  workflowRunId: z.string().min(1),
  formats: z.array(z.enum(EXPORT_FORMATS)).min(1),
  allowPartial: z.boolean().optional(),
});

export const ExportCodeReviewOutputSchema = z.object({
  status: z.enum(EXPORT_STATUSES),
  workflowRunId: z.string().min(1),
  reportId: z.string().min(1),
  reviewKey: z.string().min(1),
  completion: z.enum(COMPLETIONS),
  outcome: z.enum(OUTCOMES),
  coverage: coverageSchema,
  findings: z.object({
    total: z.number().int().nonnegative(),
    byPriority: z.object({
      P0: z.number().int().nonnegative(),
      P1: z.number().int().nonnegative(),
      P2: z.number().int().nonnegative(),
      P3: z.number().int().nonnegative(),
    }),
  }),
  files: z.array(
    z.object({
      format: z.enum(EXPORT_FORMATS),
      path: z.string().min(1),
      digest: z.string().min(1),
    }),
  ),
  gaps: z.array(reviewGapSchema),
  generatedAt: z.string().min(1),
});

export const ReviewRunResultSchema = z.object({
  formatVersion: z.literal(1),
  reviewKey: z.string().min(1),
  workflowRunId: z.string().optional(),
  input: reviewInputSchema,
  manifest: reviewManifestSchema,
  areasByUnit: z.array(unitReviewAreaSchema),
  unitResults: z.array(unitResultSchema),
  verificationResults: z.array(verificationResultSchema),
  attempts: z.array(reviewAttemptSchema),
  gaps: z.array(reviewGapSchema),
  coverage: coverageSchema,
});

/**
 * Peri Contract C entry. Note the deliberate absence of `size`, `ttlMs` and
 * `cacheScope`: the SDK Skills extension adds `size` and therefore is not
 * byte-compatible with the Peri wire shape.
 */
const skillResourceRefSchema = z.object({
  uri: z.string().min(1),
  digest: z.string().min(1),
});

const skillEntrySchema = z.object({
  uri: z.string().min(1),
  frontmatter: z.record(z.string(), z.unknown()),
  resources: z.array(skillResourceRefSchema),
});

const listSkillsParamsSchema = z.object({ cursor: z.string().optional() }).optional();

const listSkillsResultSchema = z.object({
  skills: z.array(skillEntrySchema),
  nextCursor: z.string().optional(),
});

const getSkillParamsSchema = z.object({ uri: z.string().min(1) });

const getSkillResultSchema = z.object({ skill: skillEntrySchema });

export interface ReviewServerConfig {
  /** Absolute repository root. One process is bound to one repository. */
  repoRoot: string;
  /** Root of Ultracode's read-only run records. */
  workflowRoot: string;
  /** Directory that receives JSON and Markdown reports. */
  outputDir: string;
  packageVersion?: string;
  /** Units per prepare page and unit IDs per area page. Defaults to 100. */
  pageSize?: number;
  /**
   * Extra Git options. The rule, skill and server-version identity is always
   * taken from this server so prepare and get_code_review_area agree.
   */
  repositoryOptions?: RepositoryOptions;
  /** Test seam; omitted services fall back to the real implementations. */
  services?: Partial<ReviewServices>;
}

const DEFAULT_PAGE_SIZE = 100;

function resolvePageSize(config: ReviewServerConfig): number {
  const value = config.pageSize ?? config.repositoryOptions?.pageSize;
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : DEFAULT_PAGE_SIZE;
}

function createServices(config: ReviewServerConfig, catalog: SkillCatalog): ReviewServices {
  const packageVersion = config.packageVersion ?? getPackageInfo().version;
  const rules = config.services?.rules ?? createRulesEngine({ repoRoot: config.repoRoot });
  const repository =
    config.services?.repository ??
    createRepository(config.repoRoot, {
      ...config.repositoryOptions,
      ...(config.pageSize === undefined ? {} : { pageSize: resolvePageSize(config) }),
      identity: {
        ...config.repositoryOptions?.identity,
        rulesDigest: rules.rulesDigest,
        skillDigests: skillDigestsFromCatalog(catalog),
        serverVersion: packageVersion,
      },
    });
  return {
    repository,
    reader: config.services?.reader ?? createReader(config.repoRoot),
    rules,
    reports: config.services?.reports ?? createReportBuilder(),
    runs: config.services?.runs ?? createRunStateStore(config.workflowRoot),
  };
}

function validatePrepareInput(input: PrepareCodeReviewInput): void {
  const { mode, from, to, commit } = input.input;
  switch (mode) {
    case 'range':
      if (from === undefined || to === undefined) {
        throw new ReviewError('INVALID_INPUT', 'range mode requires input.from and input.to');
      }
      if (commit !== undefined) {
        throw new ReviewError('INVALID_INPUT', 'range mode must not set input.commit');
      }
      return;
    case 'commit':
      if (commit === undefined) {
        throw new ReviewError('INVALID_INPUT', 'commit mode requires input.commit');
      }
      if (from !== undefined || to !== undefined) {
        throw new ReviewError('INVALID_INPUT', 'commit mode must not set input.from or input.to');
      }
      return;
    case 'workspace':
      if (from !== undefined || to !== undefined || commit !== undefined) {
        throw new ReviewError('INVALID_INPUT', 'workspace mode must not set input refs');
      }
      return;
    default: {
      const exhaustive: never = mode;
      throw new ReviewError('INVALID_INPUT', `unsupported review mode: ${String(exhaustive)}`);
    }
  }
}

function validateAreaInput(input: GetCodeReviewAreaInput): void {
  if (new Set(input.unitIds).size !== input.unitIds.length) {
    throw new ReviewError('INVALID_INPUT', 'unitIds must be unique');
  }
}

function validateExportInput(input: ExportCodeReviewInput): void {
  if (new Set(input.formats).size !== input.formats.length) {
    throw new ReviewError('INVALID_INPUT', 'formats must be unique');
  }
}

interface AreaCursorPayload {
  v: number;
  b: string;
  o: number;
}

/** Binds an area page cursor to the exact request that produced it. */
function areaCursorBinding(input: GetCodeReviewAreaInput): string {
  return canonicalHash({
    source: input.source,
    manifestDigest: input.manifestDigest,
    rulesDigest: input.rulesDigest,
    unitIds: input.unitIds,
    input: input.input ?? null,
    scope: input.scope ?? null,
  });
}

function encodeAreaCursor(binding: string, offset: number): string {
  const payload: AreaCursorPayload = { v: 1, b: binding, o: offset };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeAreaCursor(cursor: string | undefined, binding: string): number {
  if (cursor === undefined || cursor === '') {
    return 0;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch (error) {
    throw new ReviewError('INVALID_CURSOR', 'cursor is not a valid page cursor', { cause: error });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ReviewError('INVALID_CURSOR', 'cursor is not a valid page cursor');
  }
  const payload = parsed as Partial<AreaCursorPayload>;
  if (
    payload.v !== 1 ||
    typeof payload.b !== 'string' ||
    typeof payload.o !== 'number' ||
    !Number.isInteger(payload.o) ||
    payload.o < 0
  ) {
    throw new ReviewError('INVALID_CURSOR', 'cursor is not a valid page cursor');
  }
  if (payload.b !== binding) {
    throw new ReviewError('INVALID_CURSOR', 'cursor does not belong to this review input and manifest');
  }
  return payload.o;
}

function toolSuccess<T extends object>(value: T): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
  };
}

function toolError(error: unknown): CallToolResult {
  const reviewError = normalizeError(error);
  const payload = reviewError.toJSON();
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload as unknown as Record<string, unknown>,
  };
}

function registerTools(server: McpServer, services: ReviewServices, config: ReviewServerConfig): void {
  server.registerTool(
    'prepare_code_review',
    {
      title: 'Prepare code review',
      description:
        'Resolve a fixed Git source, build the complete ordered review manifest and return stable review identity.',
      inputSchema: PrepareCodeReviewInputSchema,
      outputSchema: PrepareCodeReviewOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => {
      try {
        validatePrepareInput(args);
        return toolSuccess(await services.repository.prepareCodeReview(args));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'get_code_review_area',
    {
      title: 'Get code review area',
      description:
        'Rebuild the prepared manifest, revalidate its digest and return the matched checks and rule identities for the requested units.',
      inputSchema: GetCodeReviewAreaInputSchema,
      outputSchema: GetCodeReviewAreaOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => {
      try {
        validateAreaInput(args);
        const manifest = await services.repository.rebuildManifest(args.source, args.scope, args.input);
        if (manifest.manifestDigest !== args.manifestDigest) {
          throw new ReviewError('SOURCE_CHANGED', 'manifestDigest does not match the current source and scope', {
            details: { expected: manifest.manifestDigest, received: args.manifestDigest },
          });
        }
        if (manifest.rulesDigest !== args.rulesDigest || services.rules.rulesDigest !== args.rulesDigest) {
          throw new ReviewError('POLICY_CHANGED', 'rulesDigest no longer matches the loaded rule catalog', {
            details: { expected: services.rules.rulesDigest, received: args.rulesDigest },
          });
        }
        const binding = areaCursorBinding(args);
        const offset = decodeAreaCursor(args.cursor, binding);
        if (offset >= args.unitIds.length) {
          throw new ReviewError('INVALID_CURSOR', 'cursor points past the end of the requested units');
        }
        const pageEnd = Math.min(offset + resolvePageSize(config), args.unitIds.length);
        const unitsById = new Map(manifest.units.map((unit) => [unit.unitId, unit]));
        const units = args.unitIds.slice(offset, pageEnd).map((unitId) => {
          const unit = unitsById.get(unitId);
          if (unit === undefined) {
            throw new ReviewError('INVALID_INPUT', `unknown unitId: ${unitId}`, { details: { unitId } });
          }
          return unit;
        });
        const areasByUnit = await services.rules.getAreas(args.source, units);
        return toolSuccess({
          areasByUnit,
          ...(pageEnd < args.unitIds.length ? { nextCursor: encodeAreaCursor(binding, pageEnd) } : {}),
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'export_code_review',
    {
      title: 'Export code review',
      description:
        'Read one completed Ultracode run, revalidate coverage and evidence, then write JSON and Markdown reports to the configured output directory.',
      inputSchema: ExportCodeReviewInputSchema,
      outputSchema: ExportCodeReviewOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => {
      try {
        validateExportInput(args);
        const result = await services.runs.load(args.workflowRunId);
        await verifyFindingEvidence(services.repository, result);
        const exported = await services.reports.exportReport(args, result, {
          workflowRunId: args.workflowRunId,
          outputDir: config.outputDir,
          packageVersion: config.packageVersion ?? getPackageInfo().version,
          generatedAt: new Date().toISOString(),
        });
        return toolSuccess(exported);
      } catch (error) {
        return toolError(error);
      }
    },
  );
}

function registerResources(server: McpServer, catalog: SkillCatalog): void {
  const digests = resourceDigestsFromCatalog(catalog);
  for (const resource of PUBLIC_RESOURCES) {
    server.registerResource(
      resource.uri,
      resource.uri,
      {
        title: resource.title,
        mimeType: resource.mimeType,
      },
      async (uri) => {
        const expected = digests.get(uri.href);
        if (expected === undefined) {
          throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown public resource: ${uri.href}`);
        }
        const loaded = await readPublicResourceText(uri.href);
        if (loaded.digest !== expected) {
          throw new ProtocolError(
            ProtocolErrorCode.InternalError,
            `Public resource changed after the skill catalog was loaded: ${uri.href}`,
          );
        }
        return {
          contents: [{ uri: uri.href, mimeType: loaded.resource.mimeType, text: loaded.text }],
        };
      },
    );
  }
}

/**
 * Adapter seam for Peri Contract C.
 *
 * The SDK Skills extension (`@modelcontextprotocol/server/ext/skills`) adds a
 * mandatory `size` field to every `resources[]` entry. Peri's DTO does not have
 * that field, so a byte-level match is impossible through `SkillsExtension`.
 * Instead we register `skills/list` and `skills/get` as custom request methods
 * with the SDK's low-level `setRequestHandler`, returning only
 * `{ uri, digest }` resource references.
 */
function registerSkillsProtocol(server: McpServer, catalog: SkillCatalog): void {
  server.server.setRequestHandler(
    SKILLS_LIST_METHOD,
    { params: listSkillsParamsSchema, result: listSkillsResultSchema },
    async (params) => {
      if (params?.cursor !== undefined && params.cursor !== '') {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          'skills/list does not paginate; the bundled catalog fits in one response',
        );
      }
      return { skills: catalog.skills };
    },
  );

  server.server.setRequestHandler(
    SKILLS_GET_METHOD,
    { params: getSkillParamsSchema, result: getSkillResultSchema },
    async ({ uri }) => {
      const skill = catalog.skills.find((entry) => entry.uri === uri);
      if (skill === undefined) {
        throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown skill: ${uri}`);
      }
      return { skill };
    },
  );

  server.server.registerCapabilities({
    extensions: {
      [SKILLS_EXTENSION_ID]: {},
    },
  });
}

export function createReviewMcpServer(config: ReviewServerConfig): McpServer {
  const packageInfo = getPackageInfo();
  // One snapshot per process: every skills/* and resources/read answer comes
  // from the same asset version, and reads are checked against its digests.
  const catalog = loadSkillCatalogSync();
  const services = createServices(config, catalog);
  const server = new McpServer(
    {
      name: packageInfo.name,
      version: config.packageVersion ?? packageInfo.version,
    },
    {
      capabilities: { tools: {}, resources: {} },
      supportedProtocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
      instructions:
        'Peri code review MCPP. Call prepare_code_review, then get_code_review_area per unit, run the Ultracode workflow, and finish with export_code_review.',
    },
  );

  registerTools(server, services, config);
  registerResources(server, catalog);
  registerSkillsProtocol(server, catalog);

  return server;
}
