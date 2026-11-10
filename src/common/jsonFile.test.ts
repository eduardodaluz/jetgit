import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { JsonFile } from './jsonFile';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jetgit-jsonfile-'));

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

interface TestState {
  version: number;
  items: string[];
}

describe('JsonFile', () => {
  it('returns the empty state when the file does not exist', async () => {
    const file = new JsonFile<TestState>(
      path.join(tmpDir, 'missing.json'),
      async () => ({ version: 1, items: [] }),
      () => ({ version: 1, items: [] }),
    );
    expect(await file.get()).toEqual({ version: 1, items: [] });
  });

  it('loads existing content and persists set() through flush()', async () => {
    const target = path.join(tmpDir, 'state.json');
    fs.writeFileSync(target, JSON.stringify({ version: 1, items: ['first'] }));
    const file = new JsonFile<TestState>(
      target,
      async () => JSON.parse(fs.readFileSync(target, 'utf8')) as TestState,
      () => ({ version: 1, items: [] }),
    );
    expect((await file.get()).items).toEqual(['first']);

    file.set({ version: 1, items: ['second'] });
    await file.flush();
    expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual({ version: 1, items: ['second'] });
  });

  it('coalesces rapid set() calls into the last value', async () => {
    const target = path.join(tmpDir, 'rapid.json');
    const file = new JsonFile<TestState>(
      target,
      async () => ({ version: 1, items: [] }),
      () => ({ version: 1, items: [] }),
    );
    await file.get();
    file.set({ version: 1, items: ['a'] });
    file.set({ version: 1, items: ['a', 'b'] });
    file.set({ version: 1, items: ['a', 'b', 'c'] });
    await file.flush();
    expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual({ version: 1, items: ['a', 'b', 'c'] });
  });
});
