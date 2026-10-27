// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
import { describe, expect, it } from 'vitest';

import { classifyPath, detectLanguage, normalizeRulePath } from './paths.js';

describe('rule path helpers', () => {
  it('normalizes separators, leading ./ and case', () => {
    expect(normalizeRulePath('.\\Src\\App.TS')).toBe('src/app.ts');
    expect(normalizeRulePath('./src/app.ts')).toBe('src/app.ts');
  });

  it('detects languages from extensions', () => {
    expect(detectLanguage('src/app.ts')).toBe('typescript');
    expect(detectLanguage('src/app.mts')).toBe('typescript');
    expect(detectLanguage('src/app.test.js')).toBe('javascript');
    expect(detectLanguage('cmd/main.go')).toBe('go');
    expect(detectLanguage('scripts/release.sh')).toBe('shell');
    expect(detectLanguage('infra/main.tf')).toBe('terraform');
    expect(detectLanguage('README.md')).toBe('');
    expect(detectLanguage('.env')).toBe('');
    expect(detectLanguage('Makefile')).toBe('');
    expect(detectLanguage('data.unknown')).toBe('');
  });

  it('classifies source, tests and configuration', () => {
    expect(classifyPath('src/app.ts')).toBe('source');
    expect(classifyPath('src/app.test.ts')).toBe('test');
    expect(classifyPath('tests/integration.py')).toBe('test');
    expect(classifyPath('src/__tests__/app.tsx')).toBe('test');
    expect(classifyPath('package.json')).toBe('build');
    expect(classifyPath('tsconfig.build.json')).toBe('build');
    expect(classifyPath('package-lock.json')).toBe('dependency');
    expect(classifyPath('go.sum')).toBe('dependency');
    expect(classifyPath('.github/workflows/ci.yml')).toBe('ci');
    expect(classifyPath('docs/guide.md')).toBe('docs');
    expect(classifyPath('README.md')).toBe('docs');
    expect(classifyPath('config/app.yaml')).toBe('config');
    expect(classifyPath('Dockerfile')).toBe('build');
    expect(classifyPath('assets/logo.bin')).toBe('unknown');
  });

  it('classifies lockfiles as dependencies before build files', () => {
    expect(classifyPath('pnpm-lock.yaml')).toBe('dependency');
    expect(classifyPath('pnpm-workspace.yaml')).toBe('config');
  });

  it('treats an empty path as unknown', () => {
    expect(classifyPath('')).toBe('unknown');
    expect(detectLanguage('')).toBe('');
  });
});
