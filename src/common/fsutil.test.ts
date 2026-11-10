import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { atomicWrite, atomicWriteJson, looksBinary, readHead, sha256 } from './fsutil';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jetgit-fsutil-'));

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('atomicWrite', () => {
  it('creates and overwrites a file, leaving no temp files behind', async () => {
    const target = path.join(tmpDir, 'state.json');
    await atomicWrite(target, Buffer.from('v1'));
    expect(fs.readFileSync(target, 'utf8')).toBe('v1');
    await atomicWrite(target, Buffer.from('v2'));
    expect(fs.readFileSync(target, 'utf8')).toBe('v2');
    const leftovers = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('writes valid JSON via atomicWriteJson', async () => {
    const target = path.join(tmpDir, 'data.json');
    await atomicWriteJson(target, { a: 1, b: 'x' });
    expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual({ a: 1, b: 'x' });
  });
});

describe('sha256', () => {
  it('is deterministic and input-sensitive', () => {
    const a = sha256(Buffer.from('hello'));
    expect(a).toBe(sha256(Buffer.from('hello')));
    expect(a).not.toBe(sha256(Buffer.from('hellp')));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('looksBinary', () => {
  it('detects a NUL byte in the head', () => {
    expect(looksBinary(Buffer.from([0x50, 0x4b, 0x00, 0x01]))).toBe(true);
    expect(looksBinary(Buffer.from('plain text file'))).toBe(false);
  });
});

describe('readHead', () => {
  it('reads at most N bytes', async () => {
    const target = path.join(tmpDir, 'head.bin');
    fs.writeFileSync(target, Buffer.alloc(100, 7));
    const head = await readHead(target, 8);
    expect(head.length).toBe(8);
  });
});
