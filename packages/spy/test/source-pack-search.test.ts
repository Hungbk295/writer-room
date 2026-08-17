import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpyService } from '../src/index.ts';
import type { YoutubePort } from '../src/adapters/ytdlp.ts';
import type { YouTubeDataApiPort } from '../src/adapters/data-api.ts';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('searchVideosForSourcePack', () => {
  test('uses yt-dlp search and does not require a YouTube Data API key', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wr-source-pack-search-'));
    roots.push(root);
    const calls: Array<{ query: string; limit: number }> = [];
    const youtube = {
      async searchVideos(query: string, limit: number) {
        calls.push({ query, limit });
        return [{
          sourceVideoId: 'abc123def45',
          canonicalUrl: 'https://www.youtube.com/watch?v=abc123def45',
          title: 'A selected video',
          channelTitle: 'Channel',
          channelId: null,
          viewCount: 123,
          durationSec: 75,
          publishedAt: null,
          thumbnailUrl: 'https://i.ytimg.com/vi/abc123def45/hqdefault.jpg',
        }];
      },
    } as YoutubePort;
    // Deliberately does not implement search/stat endpoints. A dependency on the
    // Data API would make this test fail before yt-dlp can answer.
    const service = new SpyService({
      dataRoot: root,
      youtube,
      dataApi: {} as YouTubeDataApiPort,
    });

    const videos = await service.searchVideosForSourcePack('office job stories');

    expect(calls).toEqual([{ query: 'office job stories', limit: 20 }]);
    expect(videos).toEqual([expect.objectContaining({
      videoId: 'abc123def45',
      title: 'A selected video',
      canonicalUrl: 'https://www.youtube.com/watch?v=abc123def45',
    })]);
  });
});
