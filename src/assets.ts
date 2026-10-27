// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ReviewError } from './domain/errors.js';

export interface PackageInfo {
  name: string;
  version: string;
  root: string;
}

export interface SkillResourceAsset {
  /** Path relative to the assets root. */
  path: string;
  /** Exact URI exposed through resources/read and skills/*. */
  uri: string;
}

export interface SkillAsset {
  name: string;
  skillPath: string;
  skillUri: string;
  resources: SkillResourceAsset[];
}

export interface PublicResource {
  uri: string;
  path: string;
  mimeType: string;
  title: string;
}

/**
 * The public surface is exactly three skills and one workflow example.
 * Internal rules, report templates and agent resources stay private.
 */
export const SKILL_ASSETS: readonly SkillAsset[] = [
  {
    name: 'review',
    skillPath: 'skills/review/SKILL.md',
    skillUri: 'skill://project/review/SKILL.md',
    resources: [
      { path: 'skills/review/SKILL.md', uri: 'skill://project/review/SKILL.md' },
      { path: 'workflow/example.js', uri: 'skill://project/review/example.js' },
    ],
  },
  {
    name: 'review-code',
    skillPath: 'skills/review-code/SKILL.md',
    skillUri: 'skill://project/review-code/SKILL.md',
    resources: [{ path: 'skills/review-code/SKILL.md', uri: 'skill://project/review-code/SKILL.md' }],
  },
  {
    name: 'review-verify',
    skillPath: 'skills/review-verify/SKILL.md',
    skillUri: 'skill://project/review-verify/SKILL.md',
    resources: [{ path: 'skills/review-verify/SKILL.md', uri: 'skill://project/review-verify/SKILL.md' }],
  },
];

export const WORKFLOW_EXAMPLE_ASSET: PublicResource = {
  uri: 'skill://project/review/example.js',
  path: 'workflow/example.js',
  mimeType: 'text/plain',
  title: 'Ultracode review workflow example',
};

export const PUBLIC_RESOURCES: readonly PublicResource[] = [
  ...SKILL_ASSETS.map((skill) => ({
    uri: skill.skillUri,
    path: skill.skillPath,
    mimeType: 'text/markdown',
    title: `${skill.name} skill`,
  })),
  WORKFLOW_EXAMPLE_ASSET,
];

/**
 * Finds the installed package root by walking up from the executing module.
 * The module URL is resolved first: npm runs the package through a `.bin`
 * symlink, and `--preserve-symlinks-main` makes `import.meta.url` report that
 * link, whose parents are not the package.
 */
export function resolvePackageRoot(moduleUrl: string | URL = import.meta.url): string {
  const modulePath = fileURLToPath(moduleUrl);
  let resolvedModulePath: string;
  try {
    resolvedModulePath = realpathSync(modulePath);
  } catch {
    resolvedModulePath = modulePath;
  }
  let current = dirname(resolvedModulePath);
  for (let depth = 0; depth < 8; depth += 1) {
    const packageJson = join(current, 'package.json');
    if (existsSync(packageJson) && existsSync(join(current, 'assets'))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  throw new ReviewError('ASSET_NOT_FOUND', 'Unable to locate the package root containing assets/');
}

export function resolveAssetsRoot(moduleUrl: string | URL = import.meta.url): string {
  return join(resolvePackageRoot(moduleUrl), 'assets');
}

/** Resolves a path relative to assets/ while rejecting traversal and absolute paths. */
export function resolveAssetPath(relativePath: string, moduleUrl: string | URL = import.meta.url): string {
  const assetsRoot = resolveAssetsRoot(moduleUrl);
  const target = resolve(assetsRoot, relativePath);
  const inside = relative(assetsRoot, target);
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
    throw new ReviewError('INVALID_INPUT', `Asset path escapes the assets root: ${relativePath}`);
  }
  return target;
}

export async function readAssetBytes(relativePath: string, moduleUrl: string | URL = import.meta.url): Promise<Buffer> {
  return readFile(resolveAssetPath(relativePath, moduleUrl));
}

export async function readAssetText(relativePath: string, moduleUrl: string | URL = import.meta.url): Promise<string> {
  return readAssetBytes(relativePath, moduleUrl).then((bytes) => bytes.toString('utf8'));
}

export function digestBytes(bytes: Uint8Array | string): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function getPackageInfo(moduleUrl: string | URL = import.meta.url): PackageInfo {
  const root = resolvePackageRoot(moduleUrl);
  const parsed = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown };
  return {
    name: typeof parsed.name === 'string' ? parsed.name : '@konghaoyao/peri-code-review',
    version: typeof parsed.version === 'string' ? parsed.version : '0.0.0',
    root,
  };
}

export interface SkillResourceEntry {
  uri: string;
  digest: string;
}

/**
 * Peri Contract C shape. It intentionally has no `size`, `ttlMs` or
 * `cacheScope` fields.
 */
export interface SkillCatalogEntry {
  uri: string;
  frontmatter: Record<string, unknown>;
  resources: SkillResourceEntry[];
}

export interface SkillCatalog {
  skills: SkillCatalogEntry[];
}

/**
 * Minimal parser for the concise `key: value` frontmatter used by the bundled
 * skills. It supports plain and single/double-quoted scalars; complex YAML is
 * intentionally out of scope.
 */
export function parseSkillFrontmatter(text: string): Record<string, unknown> {
  const normalized = text.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    throw new ReviewError('ASSET_NOT_FOUND', 'Skill file is missing YAML frontmatter');
  }
  const end = normalized.indexOf('\n---', 4);
  if (end === -1) {
    throw new ReviewError('ASSET_NOT_FOUND', 'Skill frontmatter is not terminated');
  }
  const frontmatter: Record<string, unknown> = {};
  for (const line of normalized.slice(4, end).split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (match === null) {
      continue;
    }
    const key = match[1];
    const raw = match[2];
    if (key === undefined || raw === undefined) {
      continue;
    }
    const value = raw.trim();
    const unquoted =
      value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
        ? value.slice(1, -1)
        : value;
    frontmatter[key] = unquoted;
  }
  return frontmatter;
}

interface SkillCatalogReaders {
  text(relativePath: string): string;
  bytes(relativePath: string): Uint8Array;
}

function buildSkillCatalog(readers: SkillCatalogReaders): SkillCatalog {
  const skills: SkillCatalogEntry[] = [];
  for (const skill of SKILL_ASSETS) {
    const frontmatter = parseSkillFrontmatter(readers.text(skill.skillPath));
    if (frontmatter.name !== skill.name) {
      throw new ReviewError('ASSET_NOT_FOUND', `Skill frontmatter name does not match its URI: ${skill.skillUri}`);
    }
    if (typeof frontmatter.description !== 'string' || frontmatter.description.trim() === '') {
      throw new ReviewError('ASSET_NOT_FOUND', `Skill frontmatter has no description: ${skill.skillUri}`);
    }
    const resources: SkillResourceEntry[] = [];
    for (const resource of skill.resources) {
      resources.push({ uri: resource.uri, digest: digestBytes(readers.bytes(resource.path)) });
    }
    // Peri rejects an activated skill whose resource list omits its own SKILL.md.
    if (!resources.some((resource) => resource.uri === skill.skillUri)) {
      throw new ReviewError('ASSET_NOT_FOUND', `Skill resources must include its own SKILL.md: ${skill.skillUri}`);
    }
    skills.push({ uri: skill.skillUri, frontmatter, resources });
  }
  return { skills };
}

/**
 * Builds one in-memory catalog snapshot. The server snapshots this at startup
 * so every `skills/list`, `skills/get` and `resources/read` answers from the
 * same asset version, and later bytes are checked against the recorded digest.
 */
export function loadSkillCatalogSync(moduleUrl: string | URL = import.meta.url): SkillCatalog {
  return buildSkillCatalog({
    text: (relativePath) => readFileSync(resolveAssetPath(relativePath, moduleUrl), 'utf8'),
    bytes: (relativePath) => readFileSync(resolveAssetPath(relativePath, moduleUrl)),
  });
}

export async function loadSkillCatalog(moduleUrl: string | URL = import.meta.url): Promise<SkillCatalog> {
  const texts = new Map<string, string>();
  const bytes = new Map<string, Uint8Array>();
  for (const skill of SKILL_ASSETS) {
    texts.set(skill.skillPath, await readAssetText(skill.skillPath, moduleUrl));
    for (const resource of skill.resources) {
      bytes.set(resource.path, await readAssetBytes(resource.path, moduleUrl));
    }
  }
  return buildSkillCatalog({
    text: (relativePath) => {
      const text = texts.get(relativePath);
      if (text === undefined) {
        throw new ReviewError('ASSET_NOT_FOUND', `Unknown skill asset: ${relativePath}`);
      }
      return text;
    },
    bytes: (relativePath) => {
      const content = bytes.get(relativePath);
      if (content === undefined) {
        throw new ReviewError('ASSET_NOT_FOUND', `Unknown skill asset: ${relativePath}`);
      }
      return content;
    },
  });
}

/** Maps each skill name to the digest of the SKILL.md that defines it. */
export function skillDigestsFromCatalog(catalog: SkillCatalog): Record<string, string> {
  const digests: Record<string, string> = {};
  for (const asset of SKILL_ASSETS) {
    const entry = catalog.skills.find((skill) => skill.uri === asset.skillUri);
    const own = entry?.resources.find((resource) => resource.uri === asset.skillUri);
    if (own === undefined) {
      throw new ReviewError('ASSET_NOT_FOUND', `Skill catalog has no self resource for ${asset.skillUri}`);
    }
    digests[asset.name] = own.digest;
  }
  return digests;
}

/** Maps every public resource URI to the digest recorded in the catalog. */
export function resourceDigestsFromCatalog(catalog: SkillCatalog): Map<string, string> {
  const digests = new Map<string, string>();
  for (const skill of catalog.skills) {
    for (const resource of skill.resources) {
      digests.set(resource.uri, resource.digest);
    }
  }
  return digests;
}

export async function readPublicResourceText(
  uri: string,
  moduleUrl: string | URL = import.meta.url,
): Promise<{ resource: PublicResource; text: string; digest: string }> {
  const resource = PUBLIC_RESOURCES.find((candidate) => candidate.uri === uri);
  if (resource === undefined) {
    throw new ReviewError('ASSET_NOT_FOUND', `Unknown public resource: ${uri}`);
  }
  const bytes = await readAssetBytes(resource.path, moduleUrl);
  return { resource, text: bytes.toString('utf8'), digest: digestBytes(bytes) };
}
