/**
 * board-metrics.test.ts — bảng số cho định nghĩa §B4 plan spy-analyst-workflow:
 * kênh 30 / 5 / 2 video ra đúng tier ✅/⚠️/🆕, bỏ chính video khỏi baseline,
 * luật 7 ngày, kênh chết, sàn view, độ lặp.
 */
import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_BOARD_SETTINGS as S,
  channelBaselineFor,
  nicheFloor,
  repeatSmall,
  scoreVideo,
  type BoardVideoInput,
} from '../src/board/metrics.ts';

const NOW = Date.parse('2026-09-29T00:00:00.000Z');
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

function vids(prefix: string, views: number[], startDaysAgo = 10): BoardVideoInput[] {
  return views.map((v, i) => ({
    videoId: `${prefix}${i}`, views: v, durationSec: 600, publishedAt: daysAgo(startDaysAgo + i),
  }));
}

const NO_NICHE = { floorViews: null, nVideos: 0 };

describe('channelBaselineFor — 3 tier, bỏ chính video', () => {
  test('30 video → reliable, median các video khác', () => {
    const channel = vids('a', Array.from({ length: 30 }, () => 1_000));
    const b = channelBaselineFor('a0', channel, S);
    expect(b.tier).toBe('reliable');
    expect(b.n).toBe(29);
    expect(b.medianViews).toBe(1_000);
  });

  test('5 video → thin; video hit bị bỏ khỏi mức thường của chính nó', () => {
    const channel = vids('b', [12_000, 400, 600, 700, 900]);
    const b = channelBaselineFor('b0', channel, S);
    expect(b.tier).toBe('thin');
    expect(b.n).toBe(4);
    expect(b.medianViews).toBe(650);
  });

  test('3 video (2 khác) → null tier; Shorts không tính', () => {
    const channel = [
      ...vids('c', [300, 45_000, 800]),
      { videoId: 'short', views: 99_999, durationSec: 40, publishedAt: daysAgo(3) },
    ];
    const b = channelBaselineFor('c1', channel, S);
    expect(b.tier).toBeNull();
    expect(b.n).toBe(2);
  });
});

describe('scoreVideo', () => {
  test('✅: 30 video, hit 5x ≥ 7 ngày → outlier', () => {
    const channel = [...vids('a', Array.from({ length: 29 }, () => 1_000)), { videoId: 'hit', views: 5_000, durationSec: 600, publishedAt: daysAgo(9) }];
    const s = scoreVideo(channel[29]!, channel, NO_NICHE, S, NOW);
    expect(s.tier).toBe('reliable');
    expect(s.outlierX).toBe(5);
    expect(s.isOutlier).toBe(true);
  });

  test('⚠️: kênh 5 video, hit 12.000 vs median 650 → 18.46x outlier', () => {
    const channel = vids('b', [12_000, 400, 600, 700, 900]);
    const s = scoreVideo(channel[0]!, channel, NO_NICHE, S, NOW);
    expect(s.tier).toBe('thin');
    expect(s.baselineN).toBe(4);
    expect(s.outlierX).toBe(18.46);
    expect(s.isOutlier).toBe(true);
  });

  test('🆕: kênh 2 video → so với sàn ngách', () => {
    const channel = vids('n', [45_000, 300]);
    const s = scoreVideo(channel[0]!, channel, { floorViews: 2_000, nVideos: 80 }, S, NOW);
    expect(s.tier).toBe('niche');
    expect(s.baselineViews).toBe(2_000);
    expect(s.baselineN).toBe(80);
    expect(s.outlierX).toBe(22.5);
    expect(s.isOutlier).toBe(true);
  });

  test('🆕 nhưng ngách chưa có sàn → không chấm', () => {
    const channel = vids('n', [45_000, 300]);
    const s = scoreVideo(channel[0]!, channel, NO_NICHE, S, NOW);
    expect(s.tier).toBeNull();
    expect(s.outlierX).toBeNull();
    expect(s.isOutlier).toBe(false);
  });

  test('video < 7 ngày → đang lên, không outlier dù 10x', () => {
    const channel = [...vids('a', Array.from({ length: 12 }, () => 1_000)), { videoId: 'young', views: 10_000, durationSec: 600, publishedAt: daysAgo(2) }];
    const s = scoreVideo(channel[12]!, channel, NO_NICHE, S, NOW);
    expect(s.isRising).toBe(true);
    expect(s.outlierX).toBe(10);
    expect(s.isOutlier).toBe(false);
  });

  test('kênh chết (≥3 video khác, median < 500) → không outlier', () => {
    const channel = vids('d', [600, 200, 200, 200, 200]);
    const s = scoreVideo(channel[0]!, channel, NO_NICHE, S, NOW);
    expect(s.dead).toBe(true);
    expect(s.outlierX).toBe(3);
    expect(s.isOutlier).toBe(false);
  });

  test('kênh 2 video không bị coi là chết', () => {
    const channel = vids('d', [5_000, 100]);
    const s = scoreVideo(channel[0]!, channel, { floorViews: 1_000, nVideos: 10 }, S, NOW);
    expect(s.dead).toBe(false);
    expect(s.isOutlier).toBe(true);
  });

  test('Shorts không được chấm', () => {
    const channel = vids('a', Array.from({ length: 12 }, () => 1_000));
    const s = scoreVideo({ videoId: 's', views: 90_000, durationSec: 30, publishedAt: daysAgo(10) }, channel, NO_NICHE, S, NOW);
    expect(s.tier).toBeNull();
    expect(s.isOutlier).toBe(false);
  });
});

describe('nicheFloor', () => {
  test('chỉ video uploads, dài, ≥ 7 ngày, của kênh nhỏ', () => {
    const base = { durationSec: 600, publishedAt: daysAgo(10), baselineEligible: true };
    const floor = nicheFloor([
      { ...base, videoId: '1', channelId: 'small1', views: 1_000 },
      { ...base, videoId: '2', channelId: 'small1', views: 3_000 },
      { ...base, videoId: '3', channelId: 'small2', views: 2_000 },
      { ...base, videoId: 'search', channelId: 'small2', views: 900_000, baselineEligible: false },
      { ...base, videoId: 'big', channelId: 'big', views: 500_000 },
      { ...base, videoId: 'young', channelId: 'small2', views: 10, publishedAt: daysAgo(1) },
      { ...base, videoId: 'short', channelId: 'small2', views: 10, durationSec: 30 },
    ], new Set(['small1', 'small2']), S, NOW);
    expect(floor).toEqual({ floorViews: 2_000, nChannels: 2, nVideos: 3 });
  });
});

describe('repeatSmall', () => {
  test('đếm kênh nhỏ khác nhau có outlier trong 28 ngày, theo tier mạnh nhất', () => {
    const out = (tier: 'reliable' | 'thin' | 'niche', isOutlier = true) => ({
      tier, baselineViews: 1, baselineN: 1, outlierX: 5, isOutlier, isRising: false, dead: false, ageDays: 10,
    });
    const r = repeatSmall([
      { channelId: 'a', publishedAt: daysAgo(10), score: out('thin') },
      { channelId: 'a', publishedAt: daysAgo(12), score: out('reliable') },
      { channelId: 'b', publishedAt: daysAgo(10), score: out('niche') },
      { channelId: 'c', publishedAt: daysAgo(40), score: out('reliable') },
      { channelId: 'd', publishedAt: daysAgo(10), score: out('reliable', false) },
      { channelId: 'big', publishedAt: daysAgo(10), score: out('reliable') },
    ], new Set(['a', 'b', 'c', 'd']), S, NOW);
    expect(r).toEqual({ total: 2, reliable: 1, thin: 0, niche: 1 });
  });
});
