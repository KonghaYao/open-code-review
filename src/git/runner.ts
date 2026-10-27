// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 alibaba/open-code-review Contributors
import { execFile, type ExecFileException } from 'node:child_process';

/**
 * Global options applied to every invocation. `core.quotepath=false` keeps
 * non-ASCII paths literal in diff headers; control characters are still quoted
 * by git and decoded by the diff parser.
 */
export const GIT_GLOBAL_ARGS: readonly string[] = ['-c', 'core.quotepath=false'];

/**
 * Environment overrides that make git deterministic and quiet. `LC_ALL=C`
 * pins messages to English, `GIT_OPTIONAL_LOCKS=0` keeps read-only commands
 * from refreshing the index, and the prompt/pager settings prevent a read from
 * ever blocking on a terminal.
 */
export const GIT_ENV_OVERRIDES: Readonly<Record<string, string>> = {
  LC_ALL: 'C',
  LANG: 'C',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
  GIT_PAGER: 'cat',
};

export function gitEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, ...GIT_ENV_OVERRIDES };
}

export type GitFailureKind = 'failed' | 'timeout' | 'output-limit';

/** Low-level git subprocess failure; the repository layer maps it to ReviewError. */
export class GitError extends Error {
  readonly command: string;
  readonly kind: GitFailureKind;
  readonly stderr: string;
  readonly exitCode?: number;

  constructor(command: string, message: string, kind: GitFailureKind, stderr: string, exitCode?: number) {
    super(message);
    this.name = 'GitError';
    this.command = command;
    this.kind = kind;
    this.stderr = stderr;
    this.exitCode = exitCode;
  }
}

export interface GitRunnerOptions {
  cwd: string;
  gitPath?: string;
  /** Wall-clock limit for one invocation. Defaults to two minutes. */
  timeoutMs?: number;
  /** stdout/stderr cap; exceeding it fails instead of buffering without bound. */
  maxBufferBytes?: number;
  /** Upper bound on concurrent subprocesses shared by one runner. */
  maxConcurrent?: number;
  env?: NodeJS.ProcessEnv;
}

export const DEFAULT_GIT_TIMEOUT_MS = 120_000;
export const DEFAULT_GIT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
export const DEFAULT_GIT_MAX_CONCURRENT = 8;

export interface GitSplitResult {
  stdout: Buffer;
  stderr: string;
}

/**
 * Runs git with an argument array (never a shell string), a fixed working
 * directory, a timeout and a bounded output buffer. Concurrent callers share a
 * semaphore so a review cannot spawn an unbounded number of git processes.
 */
export class GitRunner {
  readonly cwd: string;
  private readonly gitPath: string;
  private readonly timeoutMs: number;
  private readonly maxBufferBytes: number;
  private readonly maxConcurrent: number;
  private readonly env: NodeJS.ProcessEnv;
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(options: GitRunnerOptions) {
    this.cwd = options.cwd;
    this.gitPath = options.gitPath ?? 'git';
    this.timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
    this.maxBufferBytes = options.maxBufferBytes ?? DEFAULT_GIT_MAX_BUFFER_BYTES;
    this.maxConcurrent = options.maxConcurrent ?? DEFAULT_GIT_MAX_CONCURRENT;
    this.env = gitEnvironment(options.env);
  }

  async run(args: string[]): Promise<string> {
    const { stdout } = await this.runSplit(args);
    return stdout.toString('utf8');
  }

  async runBuffer(args: string[]): Promise<Buffer> {
    const { stdout } = await this.runSplit(args);
    return stdout;
  }

  async runSplit(args: string[]): Promise<GitSplitResult> {
    await this.acquire();
    try {
      const result = await this.execute(args);
      return { stdout: result.stdout, stderr: result.stderr.toString('utf8') };
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  private release(): void {
    this.active -= 1;
    const next = this.waiters.shift();
    if (next !== undefined) {
      next();
    }
  }

  private execute(args: string[]): Promise<{ stdout: Buffer; stderr: Buffer }> {
    const fullArgs = [...GIT_GLOBAL_ARGS, ...args];
    return new Promise((resolve, reject) => {
      execFile(
        this.gitPath,
        fullArgs,
        {
          cwd: this.cwd,
          env: this.env,
          timeout: this.timeoutMs,
          maxBuffer: this.maxBufferBytes,
          encoding: 'buffer',
          windowsHide: true,
          killSignal: 'SIGKILL',
        },
        (error: ExecFileException | null, stdout: Buffer, stderr: Buffer) => {
          if (error !== null) {
            reject(toGitError(args, error, stderr, this.timeoutMs));
            return;
          }
          resolve({ stdout, stderr });
        },
      );
    });
  }
}

function commandName(args: string[]): string {
  for (const arg of args) {
    if (!arg.startsWith('-')) {
      return arg;
    }
  }
  return '<unknown>';
}

function toGitError(args: string[], error: ExecFileException, stderr: Buffer, timeoutMs: number): GitError {
  const command = commandName(args);
  const detail = stderr.toString('utf8').trim();
  const outputLimit = error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
  const timedOut = !outputLimit && (error.killed === true || error.signal != null);
  const kind: GitFailureKind = outputLimit ? 'output-limit' : timedOut ? 'timeout' : 'failed';
  const exitCode = typeof error.code === 'number' ? error.code : undefined;

  let message: string;
  if (outputLimit) {
    message = `git ${command} exceeded the output buffer limit`;
  } else if (timedOut) {
    message = `git ${command} timed out after ${timeoutMs}ms`;
  } else if (detail !== '') {
    message = detail;
  } else {
    message = error.message !== '' ? error.message : `git ${command} failed`;
  }

  return new GitError(command, message, kind, detail, exitCode);
}
