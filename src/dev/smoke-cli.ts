// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Release gate for the npm bin. npm links `node_modules/.bin/peri-code-review`
 * to the package entry, and Node resolves `import.meta.url` to the real file
 * while `process.argv[1]` keeps the symlink path. Running the built CLI through
 * such a link is the only check that catches a silently skipped `main()`.
 */

const packageRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const cliPath = join(packageRoot, 'dist', 'cli.js');
const packageJsonPath = join(packageRoot, 'package.json');

interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

class SmokeError extends Error {}

function fail(message: string): never {
  throw new SmokeError(message);
}

function run(command: string, args: string[]): CommandResult {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 30_000 });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    ...(result.error === undefined ? {} : { error: result.error }),
  };
}

function runBin(linkPath: string, args: string[]): CommandResult {
  // Windows cannot execute a file symlink; node <link> reproduces the same
  // argv[1]/import.meta.url split.
  if (process.platform === 'win32') {
    return run(process.execPath, [linkPath, ...args]);
  }
  return run(linkPath, args);
}

function expectOutput(name: string, result: CommandResult): string {
  if (result.error !== undefined) {
    fail(`${name} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`${name} exited with ${String(result.status)}${result.stderr === '' ? '' : `: ${result.stderr.trim()}`}`);
  }
  const output = result.stdout.trim();
  if (output === '') {
    fail(`${name} produced no output; the bin symlink did not run the CLI`);
  }
  return output;
}

function smoke(): void {
  if (!existsSync(cliPath)) {
    fail(`${cliPath} is missing; run "npm run build" first`);
  }
  const { version } = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { version?: unknown };
  if (typeof version !== 'string' || version === '') {
    fail(`${packageJsonPath} has no version`);
  }

  const tempRoot = mkdtempSync(join(tmpdir(), 'ocr-bin-smoke-'));
  try {
    // Mirror a real install layout: <project>/node_modules/<pkg> plus the
    // .bin link and the runtime dependencies npm would have installed beside
    // it. Without the dependencies, `--preserve-symlinks-main` cannot resolve
    // bare imports from the .bin path.
    const installRoot = join(tempRoot, 'node_modules');
    const scopedRoot = join(installRoot, '@konghaoyao');
    mkdirSync(scopedRoot, { recursive: true });
    symlinkSync(packageRoot, join(scopedRoot, 'peri-code-review'), 'dir');
    for (const dependency of ['@modelcontextprotocol', 'zod']) {
      const source = join(packageRoot, 'node_modules', dependency);
      if (!existsSync(source)) {
        fail(`${source} is missing; run "npm ci" first`);
      }
      symlinkSync(source, join(installRoot, dependency), 'dir');
    }

    const binDir = join(installRoot, '.bin');
    mkdirSync(binDir, { recursive: true });
    const linkPath = join(binDir, 'peri-code-review');
    symlinkSync(join('..', '@konghaoyao', 'peri-code-review', 'dist', 'cli.js'), linkPath, 'file');

    const versionOutput = expectOutput('peri-code-review version', runBin(linkPath, ['version']));
    if (versionOutput !== version) {
      fail(`version printed ${JSON.stringify(versionOutput)}, expected ${JSON.stringify(version)}`);
    }

    const helpOutput = expectOutput('peri-code-review help', runBin(linkPath, ['help']));
    if (!helpOutput.includes('Usage:')) {
      fail('help output does not contain "Usage:"');
    }

    // `--preserve-symlinks-main` keeps import.meta.url on the .bin path; the
    // asset root must still resolve to the installed package.
    const preservedName = 'peri-code-review version (--preserve-symlinks-main)';
    const preservedOutput = expectOutput(
      preservedName,
      run(process.execPath, ['--preserve-symlinks-main', linkPath, 'version']),
    );
    if (preservedOutput !== version) {
      fail(`${preservedName} printed ${JSON.stringify(preservedOutput)}, expected ${JSON.stringify(version)}`);
    }

    process.stdout.write(`smoke:cli: ok (${version})\n`);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

try {
  smoke();
} catch (error) {
  process.stderr.write(`smoke:cli: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
