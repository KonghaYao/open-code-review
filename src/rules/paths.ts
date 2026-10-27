// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
import { matchesAnyGlob, normalizePathSeparators } from '../git/glob.js';

import type { PathCategory } from './catalog.js';

const TEST_PATTERNS: readonly string[] = [
  '**/*.test.*',
  '**/*.spec.*',
  '**/*_test.*',
  '**/*_spec.*',
  '**/test/**',
  '**/tests/**',
  '**/__tests__/**',
  '**/__mocks__/**',
  '**/__fixtures__/**',
  '**/fixtures/**',
  '**/testdata/**',
  '**/conftest.py',
];

const CI_PATTERNS: readonly string[] = [
  '.github/workflows/**',
  '.github/actions/**',
  '.gitlab-ci.yml',
  '.gitlab/**',
  '.circleci/**',
  '.buildkite/**',
  '.travis.yml',
  'azure-pipelines.yml',
  '**/azure-pipelines.yml',
  '**/jenkinsfile',
];

const DEPENDENCY_PATTERNS: readonly string[] = [
  '**/package-lock.json',
  '**/npm-shrinkwrap.json',
  '**/yarn.lock',
  '**/pnpm-lock.yaml',
  '**/bun.lock',
  '**/bun.lockb',
  '**/go.sum',
  '**/cargo.lock',
  '**/poetry.lock',
  '**/pipfile.lock',
  '**/composer.lock',
  '**/gemfile.lock',
  '**/gradle.lockfile',
  '**/packages.lock.json',
  '**/mix.lock',
  '**/pubspec.lock',
];

const BUILD_PATTERNS: readonly string[] = [
  '**/package.json',
  '**/tsconfig*.json',
  '**/cargo.toml',
  '**/go.mod',
  '**/pom.xml',
  '**/build.gradle',
  '**/build.gradle.kts',
  '**/settings.gradle',
  '**/settings.gradle.kts',
  '**/makefile',
  '**/gnumakefile',
  '**/dockerfile',
  '**/dockerfile.*',
  '**/*.dockerfile',
  '**/docker-compose*.yml',
  '**/docker-compose*.yaml',
  '**/compose*.yml',
  '**/compose*.yaml',
  '**/cmakelists.txt',
  '**/build.rs',
  '**/setup.py',
  '**/pyproject.toml',
  '**/requirements*.txt',
  '**/pipfile',
  '**/gemfile',
  '**/*.gemspec',
  '**/composer.json',
  '**/build',
  '**/build.bazel',
  '**/workspace',
  '**/*.csproj',
  '**/*.sln',
  '**/*.gradle',
  '**/gradle.properties',
  '**/tsup.config.*',
  '**/vite.config.*',
  '**/vitest.config.*',
  '**/jest.config.*',
];

const DOCS_PATTERNS: readonly string[] = [
  '**/*.md',
  '**/*.mdx',
  '**/*.rst',
  '**/*.adoc',
  'docs/**',
  '**/docs/**',
  'doc/**',
  '**/doc/**',
  '**/readme*',
  '**/changelog*',
  '**/contributing*',
  '**/license*',
  '**/notice*',
];

const CONFIG_PATTERNS: readonly string[] = [
  '**/*.json',
  '**/*.json5',
  '**/*.jsonc',
  '**/*.yaml',
  '**/*.yml',
  '**/*.toml',
  '**/*.ini',
  '**/*.cfg',
  '**/*.conf',
  '**/*.properties',
  '**/*.env',
  '**/.env*',
  '**/*.xml',
  '**/*.plist',
  '**/*.config.*',
  '**/.editorconfig',
  '**/.gitignore',
  '**/.gitattributes',
  '**/.npmrc',
  '**/.nvmrc',
];

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  go: 'go',
  py: 'python',
  pyi: 'python',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  rs: 'rust',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hxx: 'cpp',
  hh: 'cpp',
  cs: 'csharp',
  rb: 'ruby',
  rake: 'ruby',
  php: 'php',
  phtml: 'php',
  swift: 'swift',
  scala: 'scala',
  sc: 'scala',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  ksh: 'shell',
  sql: 'sql',
  lua: 'lua',
  dart: 'dart',
  ex: 'elixir',
  exs: 'elixir',
  erl: 'erlang',
  hrl: 'erlang',
  hs: 'haskell',
  lhs: 'haskell',
  clj: 'clojure',
  cljs: 'clojure',
  cljc: 'clojure',
  fs: 'fsharp',
  fsi: 'fsharp',
  fsx: 'fsharp',
  vue: 'vue',
  svelte: 'svelte',
  astro: 'astro',
  sol: 'solidity',
  zig: 'zig',
  nim: 'nim',
  nims: 'nim',
  jl: 'julia',
  r: 'r',
  tf: 'terraform',
  tfvars: 'terraform',
  hcl: 'hcl',
  nix: 'nix',
  graphql: 'graphql',
  gql: 'graphql',
  prisma: 'prisma',
  proto: 'protobuf',
};

/** Repository-relative, forward-slash, lower-case path used by rule matching. */
export function normalizeRulePath(path: string): string {
  const normalized = normalizePathSeparators(path.trim());
  return (normalized.startsWith('./') ? normalized.slice(2) : normalized).toLowerCase();
}

export function detectLanguage(path: string): string {
  const normalized = normalizeRulePath(path);
  const base = normalized.slice(normalized.lastIndexOf('/') + 1);
  if (base === '' || base.startsWith('.')) {
    return '';
  }
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) {
    return '';
  }
  return LANGUAGE_BY_EXTENSION[base.slice(dot + 1)] ?? '';
}

/**
 * Classifies a path for rule selection. The order is deliberate: a test file
 * named `foo.test.ts` is testing input, not source, and a lockfile is a
 * dependency change before it is a build file.
 */
export function classifyPath(path: string): PathCategory {
  const normalized = normalizeRulePath(path);
  if (normalized === '') {
    return 'unknown';
  }
  if (matchesAnyGlob(TEST_PATTERNS, normalized)) {
    return 'test';
  }
  if (matchesAnyGlob(CI_PATTERNS, normalized)) {
    return 'ci';
  }
  if (matchesAnyGlob(DEPENDENCY_PATTERNS, normalized)) {
    return 'dependency';
  }
  if (matchesAnyGlob(BUILD_PATTERNS, normalized)) {
    return 'build';
  }
  if (matchesAnyGlob(DOCS_PATTERNS, normalized)) {
    return 'docs';
  }
  if (matchesAnyGlob(CONFIG_PATTERNS, normalized)) {
    return 'config';
  }
  return detectLanguage(normalized) === '' ? 'unknown' : 'source';
}
