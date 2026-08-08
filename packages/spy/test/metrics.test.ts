import { describe, expect, test } from 'bun:test';
import {
  ageCohort,
  computeChannelMetrics,
  computeFeatureLift,
  computePerformanceMetrics,
  computeTokenLift,
  computeVideoOutlierScores,
  computeVideoMetrics,
  extractTitleFeatures,
  hasCorrelationSample,
  mad,
  median,
  outlierScore,
  percentile,
} from '../src/metrics/index.ts';

const REF = new Date('2026-08-07T00:00:00Z');

function daysAgo(n: number): Date {
  return new Date(REF.getTime() - n * 86_400_000);
}

describe('stats helpers', () => {
  test('median, percentile, MAD, outlierScore by hand', () => {
    const views = [10, 20, 30, 40, 50, 60, 70, 80];
    expect(median(views)).toBe(45);
    expect(percentile(views, 25)).toBe(27.5);
    expect(percentile(views, 75)).toBe(62.5);
    expect(percentile(views, 90)).toBe(73);

    const viewMad = mad(views);
    expect(viewMad).toBe(20);

    const score = outlierScore(80, 45, viewMad);
    expect(score).toBeCloseTo((80 - 45) / (1.4826 * 20), 5);
  });
});

describe('performance distribution gates', () => {
  test('channel with 5 videos returns insufficient_sample for distribution', () => {
    const videos = Array.from({ length: 5 }, (_, i) => ({
      videoId: `v${i}`,
      viewCount: (i + 1) * 1000,
      publishedAt: daysAgo(10 + i),
    }));

    const metrics = computePerformanceMetrics(videos, { referenceDate: REF });
    expect(metrics.sampleSize).toBe(5);
    expect(metrics.viewMedian.method).toBe('insufficient_sample');
    expect(metrics.viewMedian.have).toBe(5);
    expect(metrics.viewMedian.need).toBe(8);
    expect(metrics.viewP25.method).toBe('insufficient_sample');
    expect(metrics.viewMAD.method).toBe('insufficient_sample');

    const correlation = hasCorrelationSample(videos);
    expect(correlation.method).toBe('insufficient_sample');
    expect(correlation.have).toBe(5);
    expect(correlation.need).toBe(12);
  });

  test('channel with 8+ videos returns deterministic distribution', () => {
    const views = [10, 20, 30, 40, 50, 60, 70, 80];
    const videos = views.map((viewCount, i) => ({
      videoId: `v${i}`,
      viewCount,
      publishedAt: daysAgo(15 + i),
      likeCount: 10,
      commentCount: 2,
    }));

    const metrics = computePerformanceMetrics(videos, {
      subscriberCount: 1000,
      referenceDate: REF,
    });

    expect(metrics.viewMedian.method).toBe('deterministic');
    expect(metrics.viewMedian.value).toBe(45);
    expect(metrics.viewMAD.value).toBe(20);
    expect(metrics.viewPerSubMedian.method).toBe('deterministic');
    expect(metrics.viewPerSubMedian.value).toBeCloseTo(0.045, 5);
    expect(metrics.engagementRateMedian.method).toBe('deterministic');
  });
});

describe('soft degrade without API fields', () => {
  test('engagement and viewPerSub unavailable with reason', () => {
    const videos = Array.from({ length: 10 }, (_, i) => ({
      viewCount: 1000 * (i + 1),
      publishedAt: daysAgo(20 + i),
    }));

    const metrics = computePerformanceMetrics(videos, { referenceDate: REF });

    expect(metrics.viewPerSubMedian.method).toBe('unavailable');
    expect(metrics.viewPerSubMedian.reason).toBe('youtube_data_api_subscriber_count_missing');
    expect(metrics.engagementRateMedian.method).toBe('unavailable');
    expect(metrics.engagementRateMedian.reason).toBe('youtube_data_api_engagement_fields_missing');
    expect(metrics.viewMedian.method).toBe('deterministic');
  });
});

describe('age cohort outlier detection', () => {
  test('new high-velocity video flagged in cohort while old high-view is not global outlier', () => {
    const oldVideos = Array.from({ length: 4 }, (_, i) => ({
      videoId: `old-${i}`,
      viewCount: 100_000,
      publishedAt: daysAgo(400 + i * 10),
    }));

    const recentBaseline = Array.from({ length: 3 }, (_, i) => ({
      videoId: `recent-${i}`,
      viewCount: 500,
      publishedAt: daysAgo(10 + i),
    }));

    const breakout = {
      videoId: 'breakout',
      viewCount: 5000,
      publishedAt: daysAgo(5),
    };

    const videos = [...oldVideos, ...recentBaseline, breakout];
    const outliers = computeVideoOutlierScores(videos, REF);

    const breakoutResult = outliers.find((o) => o.videoId === 'breakout')!;
    expect(breakoutResult.cohort).toBe('0-30d');
    expect(breakoutResult.metricUsed).toBe('view');
    expect(breakoutResult.outlierScore.value!).toBeGreaterThan(1.5);

    const oldResult = outliers.find((o) => o.videoId === 'old-0')!;
    expect(oldResult.cohort).toBe('>365d');
    expect(Math.abs(oldResult.outlierScore.value!)).toBeLessThan(1.5);
  });
});

describe('title metrics', () => {
  test('token lift on known fixture', () => {
    const videos = [
      { title: '5 cách kiếm tiền online', viewCount: 10_000 },
      { title: '5 bước kiếm tiền nhanh', viewCount: 12_000 },
      { title: '5 tips kiếm tiền thụ động', viewCount: 11_000 },
      { title: 'Hướng dẫn edit video cơ bản', viewCount: 2_000 },
      { title: 'Review phim hay nhất tuần', viewCount: 1_500 },
      { title: 'Tin tức công nghệ mới nhất', viewCount: 1_800 },
    ];

    const lifts = computeTokenLift(videos);
    const kiemToken = lifts.find((l) => l.token === 'kiếm');
    expect(kiemToken).toBeDefined();
    expect(kiemToken!.videosContaining).toBeGreaterThanOrEqual(3);
    expect(kiemToken!.viewMedianWith).toBeGreaterThan(kiemToken!.viewMedianWithout);
    expect(kiemToken!.lift).toBeGreaterThan(1);

    const featureLifts = computeFeatureLift(videos);
    const numberLift = featureLifts.find((f) => f.feature === 'hasNumber');
    expect(numberLift).toBeDefined();
    expect(numberLift!.lift).toBeGreaterThan(1);
  });

  test('Vietnamese title features: 5 cách bạn không nên', () => {
    const features = extractTitleFeatures('5 cách bạn không nên');
    expect(features.hasNumber).toBe(true);
    expect(features.hasSecondPerson).toBe(true);
    expect(features.hasNegation).toBe(true);
    expect(features.openingPattern).toBe('list');
  });
});

describe('channel and video aggregators', () => {
  test('computeChannelMetrics bundles all metric groups', () => {
    const videos = Array.from({ length: 8 }, (_, i) => ({
      videoId: `v${i}`,
      viewCount: (i + 1) * 1000,
      publishedAt: daysAgo(5 + i * 3),
      durationSec: 300 + i * 60,
      title: `${i + 1} cách làm video hay`,
      likeCount: 50,
      commentCount: 5,
    }));

    const channel = computeChannelMetrics({
      videos,
      subscriberCount: 10_000,
      referenceDate: REF,
    });

    expect(channel.performance.sampleSize).toBe(8);
    expect(channel.outliers).toHaveLength(8);
    expect(channel.cadence.uploadIntervalMedianDays).toBeGreaterThan(0);
    expect(channel.duration.bands.length).toBe(5);
    expect(channel.title.features).toHaveLength(8);
  });

  test('computeVideoMetrics attaches outlier and speech', () => {
    const channelVideos = Array.from({ length: 8 }, (_, i) => ({
      videoId: `v${i}`,
      viewCount: i === 7 ? 50_000 : 1000 * (i + 1),
      publishedAt: daysAgo(5 + i),
      durationSec: 600,
      title: `Video ${i}`,
    }));

    const video = computeVideoMetrics(
      {
        videoId: 'v7',
        viewCount: 50_000,
        publishedAt: daysAgo(5),
        durationSec: 600,
        title: 'Video 7',
        transcriptSegments: [
          { startSec: 0, endSec: 5, text: 'Bạn có biết điều này không?' },
          { startSec: 8, endSec: 15, text: 'Hôm nay mình sẽ hướng dẫn bạn.' },
        ],
      },
      { channelVideos, referenceDate: REF },
    );

    expect(video.performance.outlier?.videoId).toBe('v7');
    expect(video.performance.outlier?.outlierScore.value).toBeGreaterThan(1);
    expect(video.speech?.wordsTotal).toBeGreaterThan(0);
    expect(video.speech?.secondPersonDensity).toBeGreaterThan(0);
  });
});
