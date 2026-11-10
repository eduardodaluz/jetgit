/**
 * Filesystem utilities. Pure Node — no vscode imports.
 *
 * All persistence for JetGit state files goes through `atomicWrite`:
 * same-directory temp file + rename, so a crash mid-write can never leave
 * a half-written JSON file behind (stores corrupt on read = user data loss).
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Atomic file write. Writes to `<target>.<random>.tmp` in the SAME directory
 * (rename across volumes is not atomic) and renames over the target.
 * On Windows, `rename` over an existing file can transiently fail with
 * EPERM (AV scanners, indexing) — we retry once after a short delay and
 * fall back to unlink+rename.
 */
export async function atomicWrite(target: string, data: Uint8Array): Promise<void> {
  const dir = path.dirname(target);
  await mkdirp(dir);
  const tmp = path.join(dir, `${path.basename(target)}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    await fsp.writeFile(tmp, data);
    try {
      await fsp.rename(tmp, target);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EEXIST') {
        // Retry after a beat; then force by removing the target.
        await delay(50);
        try {
          await fsp.rename(tmp, target);
          return;
        } catch {
          await fsp.rm(target, { force: true });
          await fsp.rename(tmp, target);
          return;
        }
      }
      throw err;
    }
  } finally {
    await fsp.rm(tmp, { force: true });
  }
}

export async function atomicWriteJson(target: string, value: unknown): Promise<void> {
  await atomicWrite(target, Buffer.from(JSON.stringify(value, null, 2), 'utf8'));
}

export function mkdirpSync(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export async function mkdirp(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true });
}

export function sha256(data: Uint8Array): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function sha1(text: string): string {
  return crypto.createHash('sha1').update(text, 'utf8').digest('hex');
}

/** Reads a chunk small enough for the binary sniff without loading the whole file. */
export async function readHead(filePath: string, bytes = 8192): Promise<Buffer> {
  const handle = await fsp.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Heuristic binary check: a NUL byte in the head of the file. */
export function looksBinary(head: Uint8Array): boolean {
  return head.includes(0);
}

export async function fileExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
