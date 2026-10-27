#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { getPackageInfo } from './assets.js';
import { ReviewError, normalizeError } from './domain/errors.js';
import { createReviewMcpServer } from './mcp/server.js';

const HELP = `peri-code-review - Peri code review MCPP (stdio)

Usage:
  peri-code-review serve --repo <path> [options]
  peri-code-review help
  peri-code-review version

Commands:
  serve       Start the stdio MCP server bound to one repository
  help        Show this help
  version     Show the package version

Serve options:
  --repo <path>            Repository root (required, absolute or relative)
  --workflow-root <path>   Ultracode run directory (default: <repo>/.claude/workflow-runs)
  --output-dir <path>      Report output directory (default: ~/.peri/reports/code-review)
  -h, --help               Show this help

Tools:
  prepare_code_review      Resolve fixed Git input and the complete review manifest
  get_code_review_area     Return matched checks and rule identities for units
  export_code_review       Validate an Ultracode run and export JSON + Markdown

Skills:
  skill://project/review/SKILL.md
  skill://project/review-code/SKILL.md
  skill://project/review-verify/SKILL.md
  skill://project/review/example.js
`;

export interface ServeOptions {
  repoRoot: string;
  workflowRoot: string;
  outputDir: string;
}

export interface ParsedCommand {
  command: 'serve' | 'help' | 'version';
  options?: ServeOptions;
}

function expandHome(path: string): string {
  if (path === '~') {
    return homedir();
  }
  if (path.startsWith('~/')) {
    return join(homedir(), path.slice(2));
  }
  return path;
}

function toAbsolute(path: string): string {
  return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

function takeOptionValue(args: string[], index: number, name: string): { value: string; next: number } {
  const argument = args[index];
  if (argument === undefined) {
    throw new ReviewError('INVALID_INPUT', `Missing value for ${name}`);
  }
  if (argument.startsWith('--') && !argument.includes('=')) {
    throw new ReviewError('INVALID_INPUT', `Missing value for ${name}`);
  }
  return { value: argument, next: index + 1 };
}

export function parseServeArgs(args: string[]): ServeOptions {
  let repoRoot: string | undefined;
  let workflowRoot: string | undefined;
  let outputDir: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) {
      continue;
    }
    if (argument === '--repo' || argument === '--workflow-root' || argument === '--output-dir') {
      const taken = takeOptionValue(args, index + 1, argument);
      const value = taken.value;
      index = taken.next - 1;
      if (argument === '--repo') {
        repoRoot = value;
      } else if (argument === '--workflow-root') {
        workflowRoot = value;
      } else {
        outputDir = value;
      }
      continue;
    }
    if (argument.startsWith('--repo=')) {
      repoRoot = argument.slice('--repo='.length);
      continue;
    }
    if (argument.startsWith('--workflow-root=')) {
      workflowRoot = argument.slice('--workflow-root='.length);
      continue;
    }
    if (argument.startsWith('--output-dir=')) {
      outputDir = argument.slice('--output-dir='.length);
      continue;
    }
    throw new ReviewError('INVALID_INPUT', `Unknown option: ${argument}`);
  }

  if (repoRoot === undefined || repoRoot.trim() === '') {
    throw new ReviewError('INVALID_INPUT', '--repo is required');
  }

  const resolvedRepo = toAbsolute(expandHome(repoRoot));
  let stats;
  try {
    stats = statSync(resolvedRepo);
  } catch {
    throw new ReviewError('INVALID_INPUT', `Repository does not exist: ${resolvedRepo}`);
  }
  if (!stats.isDirectory()) {
    throw new ReviewError('INVALID_INPUT', `Repository is not a directory: ${resolvedRepo}`);
  }

  return {
    repoRoot: resolvedRepo,
    workflowRoot: toAbsolute(expandHome(workflowRoot ?? join(resolvedRepo, '.claude', 'workflow-runs'))),
    outputDir: toAbsolute(expandHome(outputDir ?? join(homedir(), '.peri', 'reports', 'code-review'))),
  };
}

export function parseCommand(argv: string[]): ParsedCommand {
  const [command, ...rest] = argv;
  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    return { command: 'help' };
  }
  if (command === 'version' || command === '--version' || command === '-v') {
    return { command: 'version' };
  }
  if (command === 'serve') {
    if (rest.includes('-h') || rest.includes('--help')) {
      return { command: 'help' };
    }
    return { command: 'serve', options: parseServeArgs(rest) };
  }
  throw new ReviewError('INVALID_INPUT', `Unknown command: ${command}`);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let parsed: ParsedCommand;
  try {
    parsed = parseCommand(argv);
  } catch (error) {
    const reviewError = normalizeError(error);
    process.stderr.write(`${reviewError.code}: ${reviewError.message}\n\n${HELP}`);
    return 1;
  }

  if (parsed.command === 'help') {
    process.stdout.write(HELP);
    return 0;
  }

  if (parsed.command === 'version') {
    process.stdout.write(`${getPackageInfo().version}\n`);
    return 0;
  }

  const options = parsed.options;
  if (options === undefined) {
    process.stderr.write('serve requires --repo\n');
    return 1;
  }

  const packageInfo = getPackageInfo();
  const handle = serveStdio(
    () =>
      createReviewMcpServer({
        repoRoot: options.repoRoot,
        workflowRoot: options.workflowRoot,
        outputDir: options.outputDir,
        packageVersion: packageInfo.version,
      }),
    {
      legacy: 'reject',
      onerror: (error) => {
        process.stderr.write(`peri-code-review: ${error.message}\n`);
      },
    },
  );

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    process.stderr.write(`peri-code-review: received ${signal}, closing\n`);
    void handle.close().then(() => {
      process.exit(0);
    });
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  return 0;
}

function resolveRealPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * npm links `.bin/peri-code-review` to the package entry. Node resolves
 * `import.meta.url` to the real file while `process.argv[1]` keeps the symlink,
 * so a plain `resolve()` comparison never matches and the CLI exits silently.
 * `realpathSync` on both sides also covers `--preserve-symlinks-main`, and tsx
 * keeps working because it passes the script path as argv[1].
 */
const invokedAsScript =
  process.argv[1] !== undefined &&
  resolveRealPath(fileURLToPath(import.meta.url)) === resolveRealPath(process.argv[1]);

if (invokedAsScript) {
  void main().then((code) => {
    if (code !== 0) {
      process.exitCode = code;
    }
  });
}
