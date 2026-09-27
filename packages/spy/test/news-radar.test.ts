import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SpyService, spyTools } from '../src/index.ts';
import { NewsRadarService, newsChannelVideosUrl, dedupedCaptionText } from '../src/news-radar.ts';
import type { YoutubePort, YoutubeTranscript, YoutubeVideoObservationInfo } from '../src/adapters/ytdlp.ts';

const NOW = new Date('2026-09-27T01:00:00.000Z');

interface FakeVideo { id: string; title: string; publishedAt: string; transcript?: YoutubeTranscript }

function info(video: FakeVideo, withMetrics: boolean): YoutubeVideoObservationInfo {
  return {
    sourceVideoId: video.id, canonicalUrl: `https://www.youtube.com/watch?v=${video.id}`,
    title: video.title, channelTitle: 'Tài chính Kinh doanh', channelId: null,
    viewCount: null, likeCount: null, commentCount: null, durationSec: withMetrics ? 240 : null,
    publishedAt: withMetrics ? video.publishedAt : null,
  };
}

function okTranscript(...lines: string[]): YoutubeTranscript {
  return { status: 'ok', language: 'vi', source: 'auto', segments: lines.map((text, i) => ({ startSec: i, endSec: i + 1, text })) };
}

function fakeYoutube(videos: FakeVideo[], calls: { list: string[]; inspect: number; fallback: number }, opts: { failList?: boolean } = {}): YoutubePort {
  const byUrl = new Map(videos.map((video) => [`https://www.youtube.com/watch?v=${video.id}`, video]));
  return {
    inspectVideo: async () => { throw new Error('unused'); },
    listChannel: async () => { throw new Error('unused'); },
    streamUrl: async () => { throw new Error('unused'); },
    thumbnail: async () => ({ bytes: new Uint8Array(), mimeType: 'image/jpeg' }),
    listChannelObservation: async (url, limit) => {
      calls.list.push(url);
      if (opts.failList) throw new Error('HTTP Error 429');
      return videos.slice(0, limit).map((video) => info(video, false));
    },
    inspectVideoObservation: async (url) => {
      calls.inspect += 1;
      return info(byUrl.get(url)!, true);
    },
    fetchTranscript: async (url) => byUrl.get(url)!.transcript ?? { status: 'missing', language: null, source: 'unknown', segments: [] },
    fetchAutoSubsFallback: async () => {
      calls.fallback += 1;
      return { status: 'missing', language: null, source: 'unknown', segments: [] };
    },
  };
}

// Newest first, like the channel /videos tab.
const VIDEOS: FakeVideo[] = [
  { id: 'news0000003', title: 'Giá vàng hôm nay tăng mạnh', publishedAt: '2026-09-26T23:00:00.000Z', transcript: okTranscript('Giá vàng SJC tăng 1 triệu đồng.', 'Giá vàng SJC tăng 1 triệu đồng.', 'Nhà đầu tư thận trọng.') },
  { id: 'news0000002', title: 'Lãi suất tiết kiệm tháng 10', publishedAt: '2026-09-26T10:00:00.000Z' },
  { id: 'news0000001', title: 'VN-Index vượt 1.300 điểm', publishedAt: '2026-09-26T04:00:00.000Z', transcript: okTranscript('VN-Index tăng 15 điểm.') },
  { id: 'news0000000', title: 'Tin cũ tuần trước', publishedAt: '2026-09-20T04:00:00.000Z', transcript: okTranscript('Cũ.') },
];

let root = '';
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = '';
});

describe('newsChannelVideosUrl', () => {
  test('normalises handles, channel URLs and UC ids to the /videos tab', () => {
    expect(newsChannelVideosUrl('@TaichinhKinhdoanhTV')).toBe('https://www.youtube.com/@TaichinhKinhdoanhTV/videos');
    expect(newsChannelVideosUrl('https://www.youtube.com/@TaichinhKinhdoanhTV/videos')).toBe('https://www.youtube.com/@TaichinhKinhdoanhTV/videos');
    expect(newsChannelVideosUrl('https://m.youtube.com/@TaichinhKinhdoanhTV')).toBe('https://www.youtube.com/@TaichinhKinhdoanhTV/videos');
    expect(newsChannelVideosUrl(`UC${'a'.repeat(22)}`)).toBe(`https://www.youtube.com/channel/UC${'a'.repeat(22)}/videos`);
  });

  test('rejects anything that is not a YouTube channel, including yt-dlp flags', () => {
    for (const bad of ['--exec=rm', 'https://evil.example/@x', 'http://www.youtube.com/@abc', 'https://www.youtube.com/watch?v=abc', 'abc']) {
      expect(() => newsChannelVideosUrl(bad)).toThrow();
    }
  });
});

describe('dedupedCaptionText', () => {
  test('drops consecutive duplicate caption lines', () => {
    expect(dedupedCaptionText(okTranscript('a  b', 'a b', 'c').segments)).toBe('a b c');
  });
});

describe('NewsRadarService', () => {
  async function service(videos = VIDEOS, opts: { failList?: boolean } = {}) {
    root = await mkdtemp(join(tmpdir(), 'news-radar-'));
    const calls = { list: [] as string[], inspect: 0, fallback: 0 };
    return { news: new NewsRadarService(root, fakeYoutube(videos, calls, opts)), calls };
  }

  test('pulls new videos inside the window, newest first, with deduplicated transcripts', async () => {
    const { news, calls } = await service();
    const result = await news.pull({ channels: ['@TaichinhKinhdoanhTV'], now: NOW, maxTranscriptChars: 1_000 });
    expect(calls.list).toEqual(['https://www.youtube.com/@TaichinhKinhdoanhTV/videos']);
    expect(result.items.map((item) => item.videoId)).toEqual(['news0000003', 'news0000002', 'news0000001']);
    expect(result.items.at(0)?.transcript.text).toBe('Giá vàng SJC tăng 1 triệu đồng. Nhà đầu tư thận trọng.');
    // Missing captions: the fallback is tried and the item is still returned, flagged.
    expect(result.items.at(1)?.transcript.status).toBe('missing');
    expect(calls.fallback).toBe(1);
    // The week-old video stops the scan: no inspect beyond it.
    expect(calls.inspect).toBe(4);
    const stored = JSON.parse(await readFile(join(root, 'videos', 'news0000003.json'), 'utf8'));
    expect(stored.deliveredAt).toBeNull();
  });

  test('respects max_per_channel and truncates long transcripts', async () => {
    const long = [{ ...VIDEOS[0]!, transcript: okTranscript('x'.repeat(5_000)) }];
    const { news } = await service(long);
    const result = await news.pull({ channels: ['@TaichinhKinhdoanhTV'], now: NOW, maxPerChannel: 1, maxTranscriptChars: 1_000 });
    expect(result.items).toHaveLength(1);
    expect(result.items.at(0)?.transcript.truncated).toBe(true);
    expect(result.items.at(0)?.transcript.text).toHaveLength(1_000);
    const stored = JSON.parse(await readFile(join(root, 'videos', 'news0000003.json'), 'utf8'));
    expect(stored.transcript.text).toHaveLength(5_000);
  });

  test('acked videos are not pulled again unless include_delivered', async () => {
    const { news } = await service();
    await news.pull({ channels: ['@TaichinhKinhdoanhTV'], now: NOW });
    const ack = await news.ack([{ videoId: 'news0000003', summary: 'Vàng tăng 1 triệu.' }, { videoId: 'zzzzzzzzzzz' }], NOW);
    expect(ack).toEqual({ acked: ['news0000003'], missing: ['zzzzzzzzzzz'] });

    const again = await news.pull({ channels: ['@TaichinhKinhdoanhTV'], now: NOW });
    expect(again.items.map((item) => item.videoId)).toEqual(['news0000002', 'news0000001']);
    expect(again.notes.join(' ')).toContain('đã gửi');

    const replay = await news.pull({ channels: ['@TaichinhKinhdoanhTV'], now: NOW, includeDelivered: true });
    expect(replay.items.at(0)?.summary).toBe('Vàng tăng 1 triệu.');
    expect(replay.items.at(0)?.deliveredAt).toBe(NOW.toISOString());
  });

  test('a channel listing error is reported per channel, not thrown', async () => {
    const { news } = await service(VIDEOS, { failList: true });
    const result = await news.pull({ channels: ['@TaichinhKinhdoanhTV'], now: NOW });
    expect(result.items).toHaveLength(0);
    expect(result.skipped.at(0)?.reason).toContain('429');
  });
});

describe('spy_news_pull / spy_news_ack MCP tools', () => {
  let spy: SpyService | null = null;
  afterEach(() => {
    spy?.store.close();
    spy = null;
  });

  test('require spy.start and validate arguments', async () => {
    root = await mkdtemp(join(tmpdir(), 'news-radar-mcp-'));
    const calls = { list: [] as string[], inspect: 0, fallback: 0 };
    spy = new SpyService({ dataRoot: join(root, 'spy'), youtube: fakeYoutube(VIDEOS, calls) });
    await spy.init();
    const tools = spyTools(spy);
    const pull = tools.find((tool) => tool.name === 'spy_news_pull')!;
    const ack = tools.find((tool) => tool.name === 'spy_news_ack')!;
    const ctx = { subject: 't', scopes: new Set(['spy.start']) };

    await expect(pull.handler({ channels: ['@TaichinhKinhdoanhTV'] }, { subject: 't', scopes: new Set(['spy.read']) })).rejects.toThrow('spy.start');
    await expect(pull.handler({ channels: [] }, ctx)).rejects.toThrow('channels');
    await expect(pull.handler({ channels: ['https://evil.example/@x'] }, ctx)).rejects.toThrow();

    const pulled = await pull.handler({ channels: ['@TaichinhKinhdoanhTV'], since_hours: 168 }, ctx) as { items: Array<{ videoId: string }> };
    expect(pulled.items.length).toBeGreaterThan(0);
    await expect(ack.handler({ items: [{ video_id: 'bad' }] }, ctx)).rejects.toThrow('video_id');
    const acked = await ack.handler({ items: [{ video_id: pulled.items.at(0)!.videoId, summary: 'ok' }] }, ctx) as { acked: string[] };
    expect(acked.acked).toEqual([pulled.items.at(0)!.videoId]);
  });
});
