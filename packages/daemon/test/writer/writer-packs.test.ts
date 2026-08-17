/**
 * Writer Source Pack — create, rename, merge (multi-channel).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createWriterPack,
  getWriterPack,
  mergeIntoWriterPack,
  renameWriterPack,
  videoSectionsFromMarkdown,
} from '../../src/writer-packs.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wr-writer-packs-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function sampleMarkdown(opts: {
  channel: string;
  videos: Array<{ id: string; title: string; body: string }>;
}): string {
  const parts = [
    '# Source Pack — UNTRUSTED REFERENCE MATERIAL',
    '',
    `- Channel: ${opts.channel}`,
    '',
  ];
  for (const v of opts.videos) {
    parts.push(`## ${v.title}`, '', `- videoId: \`${v.id}\``, '', '### Transcript', '', v.body, '', '---', '');
  }
  return parts.join('\n');
}

describe('videoSectionsFromMarkdown', () => {
  test('extracts H2 sections with videoId', () => {
    const md = sampleMarkdown({
      channel: 'A',
      videos: [
        { id: 'vid1', title: 'One', body: 'hello world' },
        { id: 'vid2', title: 'Two', body: 'more text' },
      ],
    });
    const secs = videoSectionsFromMarkdown(md);
    expect(secs).toHaveLength(2);
    expect(secs[0]!.videoId).toBe('vid1');
    expect(secs[1]!.videoId).toBe('vid2');
    expect(secs[0]!.body).toContain('## One');
  });
});

describe('renameWriterPack', () => {
  test('updates title only', async () => {
    const pack = await createWriterPack({
      title: 'Old',
      channelTitle: 'Chan',
      markdown: sampleMarkdown({
        channel: 'Chan',
        videos: [{ id: 'v1', title: 'T', body: 'body words here' }],
      }),
      videoIds: ['v1'],
    }, dir);
    const renamed = await renameWriterPack(pack.id, '  Multi-channel topic X  ', dir);
    expect(renamed?.title).toBe('Multi-channel topic X');
    expect(renamed?.channelTitle).toBe('Chan');
    expect(renamed?.videoIds).toEqual(['v1']);
    await expect(renameWriterPack(pack.id, '   ', dir)).rejects.toThrow(/rỗng/);
    expect(await renameWriterPack('missing', 'x', dir)).toBeNull();
  });
});

describe('mergeIntoWriterPack', () => {
  test('appends new videos and dedupes by videoId', async () => {
    const base = await createWriterPack({
      title: 'Topic pack',
      channelTitle: 'Channel A',
      markdown: sampleMarkdown({
        channel: 'Channel A',
        videos: [
          { id: 'a1', title: 'A1', body: 'content from A one enough words' },
          { id: 'a2', title: 'A2', body: 'content from A two enough words' },
        ],
      }),
      videoIds: ['a1', 'a2'],
      spyRunId: 'run-a',
    }, dir);

    const incoming = sampleMarkdown({
      channel: 'Channel B',
      videos: [
        { id: 'a1', title: 'A1 again', body: 'should be skipped' },
        { id: 'b1', title: 'B1', body: 'content from B one enough words' },
      ],
    });

    const merged = await mergeIntoWriterPack(base.id, {
      markdown: incoming,
      videoIds: ['a1', 'b1'],
      spyRunId: 'run-b',
      channelTitle: 'Channel B',
    }, dir);

    expect(merged).not.toBeNull();
    expect(merged!.videoIds.sort()).toEqual(['a1', 'a2', 'b1']);
    expect(merged!.channelTitle).toBe('Channel A · Channel B');
    expect(merged!.markdown).toContain('## A1');
    expect(merged!.markdown).toContain('## B1');
    expect(merged!.markdown).not.toContain('should be skipped');
    expect(merged!.markdown).toContain('merged');
    expect(merged!.warnings.some((w) => w.includes('merged'))).toBe(true);

    // Second merge of only existing → no new sections
    const again = await mergeIntoWriterPack(base.id, {
      markdown: sampleMarkdown({
        channel: 'Channel B',
        videos: [{ id: 'b1', title: 'B1', body: 'dup' }],
      }),
      videoIds: ['b1'],
      channelTitle: 'Channel B',
    }, dir);
    expect(again!.videoIds.filter((id) => id === 'b1')).toHaveLength(1);
    expect(again!.warnings.some((w) => /không có video mới/i.test(w))).toBe(true);

    const loaded = await getWriterPack(base.id, dir);
    expect(loaded?.title).toBe('Topic pack');
  });
});
