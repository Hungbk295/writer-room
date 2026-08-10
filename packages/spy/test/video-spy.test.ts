import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SpyService } from '../src/index.ts';
import type { YoutubePort, YoutubeTranscript, YoutubeVideoInfo } from '../src/adapters/ytdlp.ts';
import type { YouTubeDataApiPort, VideoStatistics } from '../src/adapters/data-api.ts';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const VIDEO_ID = 'dQw4w9WgXcQ';
const VIDEO_URL = `https://www.youtube.com/watch?v=${VIDEO_ID}`;

function stubInfo(overrides: Partial<YoutubeVideoInfo> = {}): YoutubeVideoInfo {
  return {
    sourceVideoId: VIDEO_ID,
    canonicalUrl: VIDEO_URL,
    title: 'Never Gonna Give You Up',
    channelTitle: 'Rick Astley',
    channelId: 'UCuAXFkgsw1L7xaCfnd5JJOw',
    viewCount: 1_000_000,
    durationSec: 213,
    publishedAt: '2009-10-25T00:00:00.000Z',
    thumbnailUrl: `https://i.ytimg.com/vi/${VIDEO_ID}/hqdefault.jpg`,
    ...overrides,
  };
}

function mockYoutube(opts: {
  inspect?: YoutubeVideoInfo;
  transcript?: YoutubeTranscript;
  inspectCalls?: { n: number };
  transcriptCalls?: { n: number };
}): YoutubePort {
  return {
    inspectVideo: async () => {
      if (opts.inspectCalls) opts.inspectCalls.n += 1;
      return opts.inspect ?? stubInfo();
    },
    listChannel: async () => [],
    streamUrl: async () => '',
    thumbnail: async () => ({ bytes: new Uint8Array([0xff, 0xd8, 0xff]), mimeType: 'image/jpeg' }),
    fetchTranscript: async (): Promise<YoutubeTranscript> => {
      if (opts.transcriptCalls) opts.transcriptCalls.n += 1;
      return opts.transcript ?? {
        status: 'ok',
        language: 'en',
        source: 'manual',
        segments: [
          { startSec: 0, endSec: 2, text: 'Never gonna give you up' },
          { startSec: 2, endSec: 4, text: 'Never gonna let you down' },
        ],
      };
    },
  };
}

function mockDataApi(stats?: VideoStatistics | null): YouTubeDataApiPort {
  return {
    fetchVideoStatistics: async (ids) => {
      const map = new Map<string, VideoStatistics>();
      if (stats === null) return map;
      const row = stats ?? {
        videoId: VIDEO_ID,
        likeCount: 100,
        commentCount: 10,
        viewCount: 1_234_567,
        publishedAt: '2009-10-25T06:57:33Z',
        publishedAtPrecision: 'second' as const,
        durationSec: 213,
        tags: ['rick'],
        title: 'Never Gonna Give You Up',
        channelId: 'UCuAXFkgsw1L7xaCfnd5JJOw',
        channelTitle: 'Rick Astley',
        thumbnailUrl: `https://i.ytimg.com/vi/${VIDEO_ID}/hqdefault.jpg`,
      };
      for (const id of ids) {
        if (id === VIDEO_ID) map.set(id, { ...row, videoId: id });
      }
      return map;
    },
    fetchChannelStatistics: async () => new Map(),
  };
}

async function newSpy(opts: {
  youtube?: YoutubePort;
  dataApi?: YouTubeDataApiPort;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'spy-video-'));
  roots.push(root);
  const spy = new SpyService({
    dataRoot: join(root, 'spy'),
    youtube: opts.youtube ?? mockYoutube({}),
    dataApi: opts.dataApi ?? mockDataApi(),
  });
  await spy.init();
  return spy;
}

async function waitDone(spy: SpyService, operationId: string) {
  let op = await spy.wait(operationId, 5_000);
  while (op.status === 'queued' || op.status === 'running') {
    op = await spy.wait(operationId, 5_000);
  }
  return op;
}

describe('videoSpy', () => {
  test('accepts watch URL and stores one snapshot with transcript', async () => {
    const transcriptCalls = { n: 0 };
    const spy = await newSpy({
      youtube: mockYoutube({ transcriptCalls }),
      dataApi: mockDataApi(),
    });

    const started = spy.videoSpy({
      url: VIDEO_URL,
      depth: 'transcript',
      idempotencyKey: 'video-spy-test-001',
    });
    expect(started.spyRunId).toBeTruthy();
    expect(started.operationId).toBeTruthy();

    const op = await waitDone(spy, started.operationId);
    expect(op.status).toBe('completed');
    expect(transcriptCalls.n).toBe(1);

    const result = spy.getResult(started.spyRunId);
    expect(result.run.kind).toBe('video');
    expect(result.run.canonicalSource).toBe(VIDEO_URL);
    expect(result.run.sourceIdentity).toBe(`youtube:video:${VIDEO_ID}`);
    expect(result.videos).toHaveLength(1);
    expect(result.videos[0]!.sourceVideoId).toBe(VIDEO_ID);
    expect(result.videos[0]!.title).toBe('Never Gonna Give You Up');
    expect(result.videos[0]!.transcriptStatus).toBe('ok');
    expect(result.videos[0]!.transcriptCount).toBe(2);
  });

  test('accepts youtu.be and shorts URLs', async () => {
    const spy = await newSpy();
    for (const url of [
      `https://youtu.be/${VIDEO_ID}`,
      `https://www.youtube.com/shorts/${VIDEO_ID}`,
    ]) {
      const started = spy.videoSpy({
        url,
        depth: 'metadata',
        idempotencyKey: `video-spy-url-${url.slice(-8)}-${Math.random().toString(36).slice(2, 6)}`,
      });
      const op = await waitDone(spy, started.operationId);
      expect(op.status).toBe('completed');
      const result = spy.getResult(started.spyRunId);
      expect(result.videos[0]!.sourceVideoId).toBe(VIDEO_ID);
      expect(result.videos[0]!.transcriptStatus).toBe('skipped');
    }
  });

  test('metadata depth skips transcript fetch', async () => {
    const transcriptCalls = { n: 0 };
    const spy = await newSpy({
      youtube: mockYoutube({ transcriptCalls }),
    });
    const started = spy.videoSpy({
      url: VIDEO_URL,
      depth: 'metadata',
      idempotencyKey: 'video-spy-meta-only',
    });
    const op = await waitDone(spy, started.operationId);
    expect(op.status).toBe('completed');
    expect(transcriptCalls.n).toBe(0);
    const result = spy.getResult(started.spyRunId);
    expect(result.videos[0]!.transcriptStatus).toBe('skipped');
  });

  test('falls back to yt-dlp when Data API has no title', async () => {
    const inspectCalls = { n: 0 };
    const spy = await newSpy({
      youtube: mockYoutube({ inspectCalls }),
      dataApi: mockDataApi(null),
    });
    const started = spy.videoSpy({
      url: VIDEO_URL,
      depth: 'metadata',
      idempotencyKey: 'video-spy-fallback-ytdlp',
    });
    const op = await waitDone(spy, started.operationId);
    expect(op.status).toBe('completed');
    expect(inspectCalls.n).toBe(1);
    expect(spy.getResult(started.spyRunId).videos[0]!.title).toBe('Never Gonna Give You Up');
  });

  test('rejects channel URL', async () => {
    const spy = await newSpy();
    expect(() =>
      spy.videoSpy({
        url: 'https://www.youtube.com/@RickAstley/videos',
        depth: 'metadata',
        idempotencyKey: 'video-spy-reject-channel',
      }),
    ).toThrow(/video YouTube/i);
  });

  test('idempotency key returns same operation', async () => {
    const spy = await newSpy();
    const a = spy.videoSpy({
      url: VIDEO_URL,
      depth: 'metadata',
      idempotencyKey: 'video-spy-idem-key-xyz',
    });
    const b = spy.videoSpy({
      url: VIDEO_URL,
      depth: 'metadata',
      idempotencyKey: 'video-spy-idem-key-xyz',
    });
    expect(a.operationId).toBe(b.operationId);
    expect(a.spyRunId).toBe(b.spyRunId);
    await waitDone(spy, a.operationId);
  });

  test('channelSpy auto-routes video URL to videoSpy', async () => {
    const transcriptCalls = { n: 0 };
    const spy = await newSpy({
      youtube: mockYoutube({ transcriptCalls }),
    });
    const started = spy.channelSpy({
      url: VIDEO_URL,
      depth: 'transcript',
      topN: 5,
      scanLimit: 60,
      rankBy: 'velocity',
      minDurationSec: 0,
      idempotencyKey: 'channel-auto-video-route',
    });
    const op = await waitDone(spy, started.operationId);
    expect(op.status).toBe('completed');
    expect(op.kind).toBe('acquire_video');
    const result = spy.getResult(started.spyRunId);
    expect(result.run.kind).toBe('video');
    expect(result.videos).toHaveLength(1);
    expect(result.videos[0]!.sourceVideoId).toBe(VIDEO_ID);
    expect(transcriptCalls.n).toBe(1);
  });
});
