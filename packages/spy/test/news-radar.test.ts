import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SpyService, spyTools } from '../src/index.ts';
import { buildNewsRadar, titleTerms, type RadarVideo } from '../src/news-radar.ts';

const NOW = new Date('2026-09-26T12:00:00.000Z');
const SAMPLED = '2026-09-26T08:00:00.000Z';

let seq = 0;
function video(channelId: string, title: string, publishedAt: string, views: number, sampledAt = SAMPLED): RadarVideo {
  seq += 1;
  return {
    videoId: `vid${String(seq).padStart(8, '0')}`,
    channelId,
    channelTitle: `Channel ${channelId}`,
    title,
    publishedAt,
    views,
    sampledAt,
  };
}

describe('titleTerms', () => {
  test('keeps event words and bigrams, drops function and generic words', () => {
    const terms = titleTerms('The Fed Just Raised Rates — What It Costs You in 2026');
    expect(terms.has('fed')).toBe(true);
    expect(terms.has('fed raised')).toBe(true);
    expect(terms.has('the')).toBe(false);
    expect(terms.has('2026')).toBe(false);
    expect(terms.has('just')).toBe(false);
  });

  test('keeps numeric tokens such as 7%', () => {
    expect(titleTerms('Mortgage Rates Hit 7%').has('7%')).toBe(true);
  });
});

describe('buildNewsRadar', () => {
  test('qualifies an event seen on 3 channels with VPH >= 100 and marks a 2-channel topic as emerging', () => {
    // Published 2026-09-25T08:00Z, sampled 24h later → VPH = views / 24.
    const at = '2026-09-25T08:00:00.000Z';
    const radar = buildNewsRadar([
      video('A', 'BREAKING: The Fed Just Raised Interest Rates', at, 24_000),
      video('B', 'What Others Won\'t Tell You About The Fed Rate Hike', at, 12_000),
      video('C', 'The FED Just Created A Big Housing Problem', at, 4_800),
      video('A', 'Gas Prices Hit a Record High', at, 9_600),
      video('D', 'Record Gas Prices: Truckers Going Bankrupt', at, 7_200),
      video('E', 'My Morning Routine', at, 100),
    ], { now: NOW });

    const fed = radar.clusters.find((cluster) => cluster.terms.includes('fed'));
    expect(fed?.status).toBe('qualified');
    expect(fed?.qualifyingChannelCount).toBe(3);
    expect(fed?.topVph).toBe(1_000);
    expect(fed?.evidence.at(0)?.url).toStartWith('https://www.youtube.com/watch?v=');
    expect(fed?.postBy).toBe('2026-09-28T08:00:00.000Z');

    const gas = radar.clusters.find((cluster) => cluster.terms.some((term) => term.includes('gas')));
    expect(gas?.status).toBe('emerging');
    expect(radar.clusters.at(0)?.status).toBe('qualified');
    expect(radar.clusters.some((cluster) => cluster.terms.includes('routine'))).toBe(false);
  });

  test('a cluster whose videos are below min VPH does not qualify', () => {
    const at = '2026-09-25T08:00:00.000Z';
    const radar = buildNewsRadar([
      video('A', 'Medicare Changes 2027', at, 240),
      video('B', 'Medicare 2027 Explained', at, 240),
      video('C', 'Medicare Is Changing', at, 240),
    ], { now: NOW });
    const medicare = radar.clusters.find((cluster) => cluster.terms.includes('medicare'));
    expect(medicare?.status).toBe('emerging');
    expect(medicare?.qualifyingVideoCount).toBe(0);
  });

  test('ignores videos older than the window and generic words never form a cluster alone', () => {
    const radar = buildNewsRadar([
      video('A', 'Tariffs Are Back', '2026-09-10T00:00:00.000Z', 90_000),
      video('B', 'Tariffs Explained', '2026-09-10T00:00:00.000Z', 90_000),
      video('C', 'Tariffs Hit Imports', '2026-09-10T00:00:00.000Z', 90_000),
      video('A', 'Money Habits', '2026-09-25T08:00:00.000Z', 9_000),
      video('B', 'Money Rules', '2026-09-25T08:00:00.000Z', 9_000),
      video('C', 'Money Myths', '2026-09-25T08:00:00.000Z', 9_000),
    ], { now: NOW });
    expect(radar.videosInWindow).toBe(3);
    expect(radar.clusters).toHaveLength(0);
  });

  test('a headline verb shared by unrelated titles does not form a cluster', () => {
    const at = '2026-09-25T08:00:00.000Z';
    const radar = buildNewsRadar([
      video('A', 'Mortgage Rates Hit 7%', at, 9_600),
      video('B', 'America Just Hit $40 Trillion', at, 9_600),
      video('C', 'Gold Hits a New High', at, 9_600),
    ], { now: NOW });
    expect(radar.clusters.some((cluster) => cluster.terms.includes('hit') || cluster.terms.includes('hits'))).toBe(false);
  });

  test('uses the latest sample per video and accepts day-only publish dates', () => {
    const early = video('A', 'Student Loan Forgiveness Ends', '2026-09-24', 100, '2026-09-24T12:00:00.000Z');
    const later = { ...early, views: 9_600, sampledAt: '2026-09-26T00:00:00.000Z' };
    const radar = buildNewsRadar([
      early,
      later,
      video('B', 'Student Loan Payments Restart', '2026-09-24', 9_600, '2026-09-26T00:00:00.000Z'),
      video('C', 'Student Loan Borrowers Warning', '2026-09-24', 9_600, '2026-09-26T00:00:00.000Z'),
    ], { now: NOW });
    const loans = radar.clusters.find((cluster) => cluster.terms.includes('student loan'));
    expect(loans?.status).toBe('qualified');
    expect(loans?.videoCount).toBe(3);
    expect(loans?.evidence.at(0)?.vph).toBe(200);
    expect(loans?.evidence.at(0)?.publishedAtPrecision).toBe('day');
  });

  test('ignoreTerms removes channel-specific filler', () => {
    const at = '2026-09-25T08:00:00.000Z';
    const titles = ['Median Money: Rent', 'Median Money: Cars', 'Median Money: Food'];
    const radar = buildNewsRadar(titles.map((title, i) => video(`K${i}`, title, at, 9_600)), {
      now: NOW,
      ignoreTerms: ['median'],
    });
    expect(radar.clusters).toHaveLength(0);
  });
});

describe('SpyService.newsRadar + spy_news_radar MCP tool', () => {
  let root = '';
  let spy: SpyService | null = null;

  afterEach(async () => {
    spy?.store.close();
    spy = null;
    if (root) await rm(root, { recursive: true, force: true });
    root = '';
  });

  async function seed(): Promise<SpyService> {
    root = await mkdtemp(join(tmpdir(), 'spy-news-radar-'));
    const service = new SpyService({ dataRoot: join(root, 'spy') });
    await service.init();
    const channels = ['a', 'b', 'c', 'd'].map((letter) => `UC${letter.repeat(22)}`);
    for (const [index, uc] of channels.entries()) {
      service.store.upsertChannel({
        channelId: `youtube:channel:/@ch${index}`, youtubeUcId: uc, handle: `@ch${index}`, title: `Finance ${index}`,
        subscriberCount: null, videoCount: null, totalViewCount: null, fetchedAt: SAMPLED,
      });
      service.followChannel(uc, { cadence: 'daily' });
      const { run } = service.store.createOrGetPublicObservationRun({
        watchlistId: 'local-desktop', competitorChannelId: uc, planKind: 'daily', planVersion: 'public-vph-collect/v1',
        localDate: '2026-09-26', playlistLimit: 30, startedAt: SAMPLED,
      });
      service.store.insertPublicVideoStatPoint({
        observationRunId: run.id, sourceVideoId: `fedvideo00${index}`, youtubeUcId: uc, sampledAt: SAMPLED,
        viewCount: 12_000, likeCount: null, commentCount: null, durationSec: 700,
        publishedAt: '2026-09-25T08:00:00.000Z', title: `Fed Rate Hike: what it costs you (${index})`,
        availability: 'present', viewQuality: 'known', providerUsed: 'ytdlp', inspectUsed: true,
      });
    }
    // Channel d is paused: its points must not count toward the radar.
    service.pauseChannel(channels.at(3)!, {});
    return service;
  }

  test('reads followed channels only and returns coverage', async () => {
    spy = await seed();
    const radar = await spy.newsRadar({ now: NOW });
    expect(radar.coverage.followedChannels).toBe(3);
    expect(radar.videosInWindow).toBe(3);
    const fed = radar.clusters.find((cluster) => cluster.terms.includes('fed'));
    expect(fed?.status).toBe('qualified');
    expect(fed?.channelCount).toBe(3);
    expect(radar.insight).toBeNull();
  });

  test('attaches the insight profile and rejects unsafe profile names', async () => {
    spy = await seed();
    await mkdir(join(root, 'insight'), { recursive: true });
    await writeFile(join(root, 'insight', 'finance-us.md'), '# Painpoints\nN3-1 Giá thật bị giấu');
    const radar = await spy.newsRadar({ now: NOW, insightProfile: 'finance-us' });
    expect(radar.insight?.markdown).toContain('N3-1');
    await expect(spy.newsRadar({ now: NOW, insightProfile: '../config/spy' })).rejects.toThrow('insight_profile');
    await expect(spy.newsRadar({ now: NOW, insightProfile: 'missing' })).rejects.toThrow('insight_profile_not_found');
  });

  test('MCP tool requires spy.read and validates arguments', async () => {
    spy = await seed();
    const tool = spyTools(spy).find((candidate) => candidate.name === 'spy_news_radar');
    expect(tool).toBeDefined();
    await expect(tool!.handler({}, { subject: 't', scopes: new Set() })).rejects.toThrow('spy.read');
    await expect(tool!.handler({ window_days: 99 }, { subject: 't', scopes: new Set(['spy.read']) })).rejects.toThrow();
    const result = await tool!.handler({ min_channels: 2 }, { subject: 't', scopes: new Set(['spy.read']) }) as { rule: { minChannels: number } };
    expect(result.rule.minChannels).toBe(2);
  });
});
