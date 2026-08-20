/**
 * Channel style store — list, get, hash, traversal refusal.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getChannelStyle,
  hashChannelStyle,
  listChannelStyles,
} from '../../src/writer/channel-style.ts';
import { channelStylesRoot } from '../../src/paths.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wr-channel-style-'));
  mkdirSync(channelStylesRoot(dir), { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeStyle(name: string, markdown: string): void {
  writeFileSync(join(channelStylesRoot(dir), name), markdown, 'utf8');
}

const WITH_VERSION = '<!-- version: 3 -->\n\n# Style: nhân vật xuyên suốt\n\nMột nhân vật đi hết bài.\n';
const WITHOUT_VERSION = '# Style: kể chuyện\n\nKhông có header version.\n';

describe('listChannelStyles', () => {
  test('returns path/version/title/hash for each .md file', async () => {
    writeStyle('nhan-vat-xuyen-suot.md', WITH_VERSION);
    writeStyle('ke-chuyen.md', WITHOUT_VERSION);

    const list = await listChannelStyles(dir);
    expect(list.map((s) => s.path)).toEqual(['ke-chuyen.md', 'nhan-vat-xuyen-suot.md']);

    const nhanVat = list[1]!;
    expect(nhanVat.version).toBe(3);
    expect(nhanVat.title).toBe('Style: nhân vật xuyên suốt');
    expect(nhanVat.hash).toBe(hashChannelStyle(WITH_VERSION));
    expect(nhanVat.wordCount).toBe(WITH_VERSION.split(/\s+/).filter(Boolean).length);
  });

  test('skips non-markdown files', async () => {
    writeStyle('real.md', WITH_VERSION);
    writeStyle('notes.txt', 'not a style');
    writeStyle('README', 'not a style either');

    const list = await listChannelStyles(dir);
    expect(list.map((s) => s.path)).toEqual(['real.md']);
  });

  test('empty root → []', async () => {
    expect(await listChannelStyles(dir)).toEqual([]);
  });
});

describe('getChannelStyle', () => {
  test('reads the markdown back with a matching hash', async () => {
    writeStyle('nhan-vat-xuyen-suot.md', WITH_VERSION);

    const style = await getChannelStyle('nhan-vat-xuyen-suot.md', dir);
    expect(style).not.toBeNull();
    expect(style!.markdown).toBe(WITH_VERSION);
    expect(style!.hash).toBe(hashChannelStyle(WITH_VERSION));
    expect(style!.path).toBe('nhan-vat-xuyen-suot.md');
    expect(style!.version).toBe(3);
    expect(style!.title).toBe('Style: nhân vật xuyên suốt');
  });

  test('missing `<!-- version -->` header → version null, title still parsed', async () => {
    writeStyle('ke-chuyen.md', WITHOUT_VERSION);

    const style = await getChannelStyle('ke-chuyen.md', dir);
    expect(style?.version).toBeNull();
    expect(style?.title).toBe('Style: kể chuyện');
  });

  test('falls back to the filename when there is no `# ` heading', async () => {
    writeStyle('no-heading.md', '<!-- version: 1 -->\n\nchỉ có thân bài.\n');

    const style = await getChannelStyle('no-heading.md', dir);
    expect(style?.title).toBe('no-heading');
  });

  test('refuses paths that escape the root', async () => {
    writeFileSync(join(dir, 'secrets.md'), 'top secret', 'utf8');

    expect(await getChannelStyle('../secrets.md', dir)).toBeNull();
    expect(await getChannelStyle('a/../../secrets.md', dir)).toBeNull();
    expect(await getChannelStyle('/etc/passwd', dir)).toBeNull();
  });

  test('refuses non-markdown and empty paths', async () => {
    writeStyle('notes.txt', 'not a style');

    expect(await getChannelStyle('notes.txt', dir)).toBeNull();
    expect(await getChannelStyle('', dir)).toBeNull();
  });

  test('missing file → null', async () => {
    expect(await getChannelStyle('nope.md', dir)).toBeNull();
  });
});
