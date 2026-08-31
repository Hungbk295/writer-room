import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hookLibrariesRoot } from '../../src/paths.ts';
import { getHookLibrary, hashHookLibrary, listHookLibraries } from '../../src/writer/hook-library.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wr-hook-lib-'));
  mkdirSync(hookLibrariesRoot(dir), { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const SAMPLE = '<!-- version: 1 -->\n\n# Hook đối thủ\n\nKhung mở bài, không phải sự thật.\n';

describe('listHookLibraries', () => {
  test('returns path/version/title/hash for each .md file', async () => {
    writeFileSync(join(hookLibrariesRoot(dir), 'anh-ba-ong-chu.md'), SAMPLE, 'utf8');
    writeFileSync(join(hookLibrariesRoot(dir), 'notes.txt'), 'no', 'utf8');
    const list = await listHookLibraries(dir);
    expect(list.map((s) => s.path)).toEqual(['anh-ba-ong-chu.md']);
    expect(list[0]!.version).toBe(1);
    expect(list[0]!.title).toBe('Hook đối thủ');
    expect(list[0]!.hash).toBe(hashHookLibrary(SAMPLE));
  });

  test('empty root → []', async () => {
    expect(await listHookLibraries(dir)).toEqual([]);
  });
});

describe('getHookLibrary', () => {
  test('reads markdown and refuses path escape', async () => {
    writeFileSync(join(hookLibrariesRoot(dir), 'anh-ba-ong-chu.md'), SAMPLE, 'utf8');
    const lib = await getHookLibrary('anh-ba-ong-chu.md', dir);
    expect(lib?.markdown).toBe(SAMPLE);
    expect(await getHookLibrary('../channel-styles/x.md', dir)).toBeNull();
    expect(await getHookLibrary('missing.md', dir)).toBeNull();
  });
});
