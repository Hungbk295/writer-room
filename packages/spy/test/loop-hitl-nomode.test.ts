/**
 * loop-hitl-nomode.test.ts — tôn chỉ HITL cho nhịp KHÔNG truyền mode.
 *
 * Sau tích hợp v3, caller nào quên `mode` cũng phải chạy như nhịp daily —
 * nhịp thận trọng nhất: 0 search call (§2: search chỉ thuộc weekly/setup),
 * không status nào vượt quá vùng an toàn của máy (new|pending), mọi dòng
 * decisions actor='loop' chỉ được to_status ∈ {new, pending, rejected}.
 *
 * Chạy qua LoopRunner THẬT (đường production) với Data API giả đếm call —
 * cùng cách auto-loop-hardgate.test.ts chứng minh bằng trace + sổ quota.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SpyStore } from '../src/store.ts';
import { QuotaLedger } from '../src/quota.ts';
import { DiscoveryService } from '../src/discovery.ts';
import { LoopRunner } from '../src/loop/runner.ts';
import { QuotaCountingDataApi } from '../src/adapters/quota-counting-data-api.ts';
import type {
  ChannelStatistics,
  PlaylistVideoItem,
  SearchHit,
  SearchInput,
  VideoStatistics,
  YouTubeDataApiPort,
} from '../src/adapters/data-api.ts';

let tempDir = '';
const openStores: SpyStore[] = [];

afterEach(async () => {
  for (const store of openStores.splice(0)) store.close();
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = '';
});

/** Fake tối thiểu: đếm số request từng endpoint, trả payload rỗng hợp lệ —
 *  đủ để tick chạy hết đường mà không sinh dữ liệu ngoài ý muốn. */
class CountingDataApi implements YouTubeDataApiPort {
  readonly calls: Record<string, number> = {};
  private mark(endpoint: string): void {
    this.calls[endpoint] = (this.calls[endpoint] ?? 0) + 1;
  }
  count(endpoint: string): number {
    return this.calls[endpoint] ?? 0;
  }
  async search(_input: SearchInput): Promise<{ hits: SearchHit[]; nextPageToken: string | null }> {
    this.mark('search.list');
    return { hits: [], nextPageToken: null };
  }
  async fetchChannelStatistics(channelIds: readonly string[]): Promise<Map<string, ChannelStatistics>> {
    this.mark('channels.list');
    const map = new Map<string, ChannelStatistics>();
    for (const channelId of channelIds) {
      map.set(channelId, {
        channelId, title: `Kênh ${channelId}`, description: 'personal finance',
        subscriberCount: 50_000, videoCount: 100, viewCount: 1_000_000,
        uploadsPlaylistId: `UU${channelId.slice(2)}`,
        publishedAt: '2020-01-01T00:00:00.000Z', country: 'US',
      });
    }
    return map;
  }
  async fetchVideoStatistics(videoIds: readonly string[]): Promise<Map<string, VideoStatistics>> {
    this.mark('videos.list');
    const map = new Map<string, VideoStatistics>();
    videoIds.forEach((videoId) => {
      map.set(videoId, {
        videoId, likeCount: 10, commentCount: 2, viewCount: 20_000,
        publishedAt: '2026-09-01T00:00:00.000Z', publishedAtPrecision: 'second',
        durationSec: 600, tags: [], title: `Video ${videoId}`,
        channelId: 'UCtraced', channelTitle: 'Traced',
        thumbnailUrl: null, defaultAudioLanguage: 'en', defaultLanguage: null,
      });
    });
    return map;
  }
  async listUploadsPlaylistItems(_id: string, _limit: number): Promise<PlaylistVideoItem[]> {
    this.mark('playlistItems.list');
    return [];
  }
  async fetchFeaturedChannels(_channelId: string): Promise<string[]> {
    this.mark('channelSections.list');
    return [];
  }
}

async function harness() {
  tempDir = await mkdtemp(join(tmpdir(), 'spy-hitl-nomode-'));
  const store = new SpyStore(join(tempDir, 'spy.sqlite'));
  openStores.push(store);
  const quota = new QuotaLedger(store);
  const api = new CountingDataApi();
  const counting = new QuotaCountingDataApi(api, quota, () => true);
  const discovery = new DiscoveryService(store, counting, quota);
  const loop = new LoopRunner({ store, quota, discovery, dataApi: counting, dataRoot: tempDir });
  return { store, quota, api, loop };
}

const TOPIC = 'fin-us';

describe('HITL — runTick KHÔNG truyền mode phải chạy như daily', () => {
  test('0 search call; không status nào vượt vùng máy; decisions loop chỉ new|pending|rejected', async () => {
    const { store, api, loop } = await harness();
    store.upsertTopic({
      topicId: TOPIC, label: 'Finance US', market: 'us', language: 'en', region: 'US',
    });
    // Kênh chờ duyệt + keyword pending — tình huống dễ vượt quyền nhất.
    store.upsertTopicChannelCandidate({
      topicId: TOPIC, channelId: 'UCinbox00000000000001', title: 'Inbox Chan',
      discoveredVia: 'seed',
    });
    store.upsertKeywordCandidate({
      topicId: TOPIC, termKey: 'old_money', displayTerm: 'old money',
      origin: 'seed', evidenceJson: '{}',
    });

    const result = await loop.runTick(TOPIC); // ← cố ý KHÔNG truyền mode

    // Daily v3 không được gọi search.list — search thuộc weekly/setup.
    expect(api.count('search.list')).toBe(0);
    expect(result.searchCallsUsed).toBe(0);

    // Không dòng nào bị máy nâng/pause: chỉ new|pending được tồn tại sau tick.
    const channelStatuses = store.listTopicChannelsByStatus(
      TOPIC, ['new', 'active', 'paused', 'rejected', 'own'],
    ).map((r) => r.status);
    expect(channelStatuses.every((s) => s === 'new' || s === 'rejected')).toBe(true);
    const keywordStatuses = store.listKeywordsByStatus(
      TOPIC, ['pending', 'active', 'paused', 'rejected'],
    ).map((r) => r.status);
    expect(keywordStatuses.every((s) => s === 'pending' || s === 'rejected')).toBe(true);

    // Mọi quyết định của máy phải nằm trong vùng an toàn — bằng chứng tôn chỉ 1.
    const loopDecisions = (store.rawDb.prepare(
      "SELECT to_status FROM decisions WHERE topic_id = ? AND actor = 'loop'",
    ).all(TOPIC) as Array<{ to_status: string }>);
    for (const d of loopDecisions) {
      expect(['new', 'pending', 'rejected']).toContain(d.to_status);
    }
  });
});
