import { deterministic, insufficientSample, MIN_VIDEOS_FOR_DISTRIBUTION, type MetricValue } from './gates.ts';
import { median } from './stats.ts';

export type DurationBand = '<3m' | '3-8m' | '8-15m' | '15-30m' | '>30m';

export interface DurationVideoInput {
  durationSec: number;
  viewCount: number;
}

export interface DurationBandMetrics {
  band: DurationBand;
  count: number;
  viewMedian: number;
  liftVsChannel: number;
}

export interface DurationMetrics {
  bands: DurationBandMetrics[];
  durationMedianSec: number;
}

const BAND_THRESHOLDS: Array<{ band: DurationBand; minSec: number; maxSec: number }> = [
  { band: '<3m', minSec: 0, maxSec: 180 },
  { band: '3-8m', minSec: 180, maxSec: 480 },
  { band: '8-15m', minSec: 480, maxSec: 900 },
  { band: '15-30m', minSec: 900, maxSec: 1800 },
  { band: '>30m', minSec: 1800, maxSec: Infinity },
];

export function durationBand(durationSec: number): DurationBand {
  for (const { band, minSec, maxSec } of BAND_THRESHOLDS) {
    if (durationSec >= minSec && durationSec < maxSec) return band;
  }
  return '>30m';
}

export function computeDurationMetrics(videos: DurationVideoInput[]): DurationMetrics {
  const channelViewMedian = videos.length > 0 ? median(videos.map((v) => v.viewCount)) : 0;
  const durations = videos.map((v) => v.durationSec);

  const bands: DurationBandMetrics[] = BAND_THRESHOLDS.map(({ band, minSec, maxSec }) => {
    const inBand = videos.filter((v) => v.durationSec >= minSec && v.durationSec < maxSec);
    const bandViewMedian = inBand.length > 0 ? median(inBand.map((v) => v.viewCount)) : 0;
    const liftVsChannel = channelViewMedian > 0 ? bandViewMedian / channelViewMedian : 0;
    return {
      band,
      count: inBand.length,
      viewMedian: bandViewMedian,
      liftVsChannel,
    };
  });

  return {
    bands,
    durationMedianSec: durations.length > 0 ? median(durations) : 0,
  };
}

export function durationMetricsValue(videos: DurationVideoInput[]): MetricValue<DurationMetrics> {
  if (videos.length < MIN_VIDEOS_FOR_DISTRIBUTION) {
    return insufficientSample(videos.length, MIN_VIDEOS_FOR_DISTRIBUTION);
  }
  return deterministic(computeDurationMetrics(videos));
}
