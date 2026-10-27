// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
import { matchesAnyGlob } from '../git/glob.js';
import { normalizeRepoPath } from '../git/paths.js';

/** Dependency and build output directories are a wholesale policy exclusion. */
export const DEFAULT_EXCLUDED_DIRS: readonly string[] = [
  '.git',
  'node_modules',
  'vendor',
  'dist',
  'build',
  'target',
  '.next',
  '.nuxt',
  'coverage',
  '.cache',
  '__pycache__',
  '.venv',
];

export const TEST_PATTERNS: readonly string[] = [
  '**/*_test.go',
  '**/test_*.py',
  '**/*_test.py',
  '**/*.test.js',
  '**/*.test.jsx',
  '**/*.test.ts',
  '**/*.test.tsx',
  '**/*.spec.js',
  '**/*.spec.jsx',
  '**/*.spec.ts',
  '**/*.spec.tsx',
  '**/__tests__/**',
  '**/tests/**',
  '**/test/**',
  '**/*_spec.rb',
  '**/*Test.java',
  '**/*Tests.java',
  '**/*Test.kt',
  '**/src/test/**',
  '**/*Test.fs',
];

const SECRET_NAMES: readonly string[] = [
  '.env',
  '.env.local',
  '.env.production',
  '.env.development',
  'id_rsa',
  'id_ed25519',
  'credentials',
  'credentials.json',
  'secrets.yml',
  'secrets.yaml',
  'secret.yaml',
];

const SECRET_SUFFIXES: readonly string[] = ['.pem', '.key', '.p12', '.pfx', '.keystore'];

/**
 * Credentials are hard-excluded from diffs, reads and searches. No include
 * pattern can override this.
 */
export function isSecretPath(path: string): boolean {
  const normalized = normalizeRepoPath(path);
  if (normalized === '') {
    return false;
  }
  const segments = normalized.split('/');
  const base = (segments[segments.length - 1] ?? '').toLowerCase();
  for (const name of SECRET_NAMES) {
    if (base === name || base.startsWith(`${name}.`)) {
      return true;
    }
  }
  return SECRET_SUFFIXES.some((suffix) => base.endsWith(suffix));
}

export function isProviderPath(path: string): boolean {
  const normalized = normalizeRepoPath(path);
  if (normalized === '') {
    return false;
  }
  return DEFAULT_EXCLUDED_DIRS.some(
    (dir) => normalized === dir || normalized.startsWith(`${dir}/`) || normalized.includes(`/${dir}/`),
  );
}

export function isTestPath(path: string): boolean {
  const normalized = normalizeRepoPath(path);
  return normalized !== '' && matchesAnyGlob(TEST_PATTERNS, normalized);
}
