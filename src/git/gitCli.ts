/**
 * Raw git execution. This module exists because the vscode.git public API
 * does not expose `commit --only`, path-checkout, `rev-parse`, or porcelain
 * blame — everything here shells out to the SAME git binary the built-in
 * extension uses (api.git.path).
 *
 * Hard rules (violating any of these is a Windows security/correctness bug):
 * - spawn with an args ARRAY, never a shell string (injection + quoting).
 * - `--no-optional-locks` on read-only commands: never contend with the
 *   built-in extension's index.lock.
 * - Multi-path arguments travel via `--pathspec-from-file=<tmpfile>
 *   --pathspec-file-nul`, never via argv (spaces/unicode/newline filenames).
 * - stdout stays a Buffer; patch/show output must never be text-translated.
 * - GIT_TERMINAL_PROMPT=0: a hung credential prompt would freeze the
 *   extension host — fail fast instead.
 */
import { spawn } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { timed } from '../common/log';

const DEFAULT_TIMEOUT_MS = 120_000;
const MIN_VERSION = { major: 2, minor: 31 }; // --pathspec-from-file shipped in 2.25; 2.31 is the safety floor

export interface GitCliOptions {
  readonly timeoutMs?: number;
}

export interface GitCliResult {
  readonly stdout: Buffer;
  readonly stderr: string;
  readonly code: number;
}

export class GitCliError extends Error {
  constructor(
    message: string,
    public readonly result: GitCliResult,
    public readonly args: string[],
  ) {
    super(message);
    this.name = 'GitCliError';
  }
}

/** Temp pathspec file: NUL-delimited paths, cleaned up by `dispose()`. */
export class PathspecFile {
  private constructor(
    public readonly path: string,
    private readonly cleanup: () => Promise<void>,
  ) {}

  static async create(paths: readonly string[]): Promise<PathspecFile> {
    const tmp = path.join(os.tmpdir(), `jetgit-ps-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
    const contents = paths.map((p) => p.replace(/\\/g, '/')).join('\0');
    await fsp.writeFile(tmp, contents, 'utf8');
    return new PathspecFile(tmp, async () => {
      await fsp.rm(tmp, { force: true });
    });
  }

  dispose(): Promise<void> {
    return this.cleanup();
  }
}

/** A temp file holding arbitrary bytes (commit message, etc.). */
export class TempTextFile {
  private constructor(
    public readonly path: string,
    private readonly cleanup: () => Promise<void>,
  ) {}

  static async create(contents: string): Promise<TempTextFile> {
    const tmp = path.join(os.tmpdir(), `jetgit-txt-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
    await fsp.writeFile(tmp, contents, 'utf8');
    return new TempTextFile(tmp, async () => {
      await fsp.rm(tmp, { force: true });
    });
  }

  dispose(): Promise<void> {
    return this.cleanup();
  }
}

export class GitCli {
  constructor(private readonly gitPath: () => string) {}

  /** Write-style command: `-c core.quotepath=false <args>`. */
  async run(cwd: string, args: string[], opts?: GitCliOptions): Promise<GitCliResult> {
    return this.exec(cwd, ['-c', 'core.quotepath=false', ...args], opts);
  }

  /** Read-only command: `--no-optional-locks -c core.quotepath=false <args>`. */
  async runReadOnly(cwd: string, args: string[], opts?: GitCliOptions): Promise<GitCliResult> {
    return this.exec(cwd, ['--no-optional-locks', '-c', 'core.quotepath=false', ...args], opts);
  }

  private exec(cwd: string, args: string[], opts?: GitCliOptions): Promise<GitCliResult> {
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return timed(`git ${args.slice(0, 4).join(' ')}…`, () => {
      return new Promise<GitCliResult>((resolve, reject) => {
        const child = spawn(this.gitPath(), args, {
          cwd,
          windowsHide: true,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let settled = false;

        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            child.kill();
            reject(new GitCliError(`git timed out after ${timeoutMs} ms`, { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString('utf8'), code: -1 }, args));
          }
        }, timeoutMs);

        child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
        child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
        child.on('error', (err) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(err);
          }
        });
        child.on('close', (code) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve({
              stdout: Buffer.concat(stdout),
              stderr: Buffer.concat(stderr).toString('utf8'),
              code: code ?? -1,
            });
          }
        });
      });
    });
  }

  /** Runs a command, rejecting with a formatted GitCliError on non-zero exit. */
  async runChecked(cwd: string, args: string[], opts?: GitCliOptions): Promise<Buffer> {
    const result = await this.run(cwd, args, opts);
    if (result.code !== 0) {
      throw new GitCliError(this.formatError(result, args), result, args);
    }
    return result.stdout;
  }

  async runReadOnlyChecked(cwd: string, args: string[], opts?: GitCliOptions): Promise<Buffer> {
    const result = await this.runReadOnly(cwd, args, opts);
    if (result.code !== 0) {
      throw new GitCliError(this.formatError(result, args), result, args);
    }
    return result.stdout;
  }

  formatError(result: GitCliResult, args: string[]): string {
    const firstLine = result.stderr.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)[0] ?? `exit code ${result.code}`;
    return `git ${args[0]} failed: ${firstLine}`;
  }

  /** Probes `git --version`; returns null when git is unusable. */
  async probeVersion(): Promise<{ major: number; minor: number; patch: number } | null> {
    try {
      const stdout = await this.runChecked('', ['--version'], { timeoutMs: 5_000 });
      const match = /^git version (\d+)\.(\d+)\.(\d+)/.exec(stdout.toString('utf8').trim());
      if (!match) {
        return null;
      }
      return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
    } catch {
      return null;
    }
  }

  satisfiesMinVersion(version: { major: number; minor: number; patch: number }): boolean {
    return version.major > MIN_VERSION.major || (version.major === MIN_VERSION.major && version.minor >= MIN_VERSION.minor);
  }
}

/** Convenience: NUL-delimited pathspec args to append after a command. */
export function pathspecArgs(patchFile: PathspecFile): string[] {
  return ['--pathspec-from-file=' + patchFile.path.replace(/\\/g, '/'), '--pathspec-file-nul'];
}

/** Creates and disposes pathspec files around an operation. */
export async function withPathspecFiles<T>(filesList: readonly string[][], fn: (...files: PathspecFile[]) => Promise<T>): Promise<T> {
  const files = await Promise.all(filesList.map((paths) => PathspecFile.create(paths)));
  try {
    return await fn(...files);
  } finally {
    await Promise.all(files.map((f) => f.dispose()));
  }
}

/** Ensures a temp dir exists for pathspec files on platforms where os.tmpdir may be missing. */
export function ensureTmp(): void {
  try {
    fs.mkdirSync(os.tmpdir(), { recursive: true });
  } catch {
    // os.tmpdir() is a system path; if it does not exist we have bigger problems.
  }
}
