import { deterministic } from './gates.ts';
import { median, percentile } from './stats.ts';

export interface CadenceVideoInput {
  publishedAt: Date | string;
}

export interface CadenceMetrics {
  uploadIntervalMedianDays: number;
  uploadIntervalP25: number;
  uploadIntervalP75: number;
  trend: 'accelerating' | 'steady' | 'slowing';
  dayOfWeekHistogram: Record<string, number>;
  longestGapDays: number;
  activeSpanDays: number;
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MS_PER_DAY = 86_400_000;

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function intervalsDays(sortedDates: Date[]): number[] {
  const intervals: number[] = [];
  for (let i = 1; i < sortedDates.length; i++) {
    const gap = (sortedDates[i]!.getTime() - sortedDates[i - 1]!.getTime()) / MS_PER_DAY;
    intervals.push(gap);
  }
  return intervals;
}

function computeTrend(intervals: number[]): 'accelerating' | 'steady' | 'slowing' {
  if (intervals.length < 4) return 'steady';

  const recentCount = Math.min(10, Math.floor(intervals.length / 2));
  const recent = intervals.slice(-recentCount);
  const previous = intervals.slice(-recentCount * 2, -recentCount);

  if (previous.length === 0) return 'steady';

  const recentMean = recent.reduce((a, b) => a + b, 0) / recent.length;
  const previousMean = previous.reduce((a, b) => a + b, 0) / previous.length;

  const ratio = recentMean / previousMean;
  if (ratio < 0.85) return 'accelerating';
  if (ratio > 1.15) return 'slowing';
  return 'steady';
}

export function computeCadenceMetrics(videos: CadenceVideoInput[]): CadenceMetrics {
  if (videos.length === 0) {
    return {
      uploadIntervalMedianDays: 0,
      uploadIntervalP25: 0,
      uploadIntervalP75: 0,
      trend: 'steady',
      dayOfWeekHistogram: Object.fromEntries(DAY_NAMES.map((d) => [d, 0])),
      longestGapDays: 0,
      activeSpanDays: 0,
    };
  }

  const dates = videos.map((v) => toDate(v.publishedAt)).sort((a, b) => a.getTime() - b.getTime());
  const intervals = intervalsDays(dates);

  const dayOfWeekHistogram: Record<string, number> = Object.fromEntries(DAY_NAMES.map((d) => [d, 0]));
  for (const date of dates) {
    const day = DAY_NAMES[date.getDay()]!;
    dayOfWeekHistogram[day] = (dayOfWeekHistogram[day] ?? 0) + 1;
  }

  const activeSpanDays =
    dates.length > 1
      ? (dates[dates.length - 1]!.getTime() - dates[0]!.getTime()) / MS_PER_DAY
      : 0;

  return {
    uploadIntervalMedianDays: intervals.length > 0 ? median(intervals) : 0,
    uploadIntervalP25: intervals.length > 0 ? percentile(intervals, 25) : 0,
    uploadIntervalP75: intervals.length > 0 ? percentile(intervals, 75) : 0,
    trend: computeTrend(intervals),
    dayOfWeekHistogram,
    longestGapDays: intervals.length > 0 ? Math.max(...intervals) : 0,
    activeSpanDays,
  };
}

/** Wrap cadence metrics with deterministic method marker for API consistency. */
export function cadenceMetricsValue(videos: CadenceVideoInput[]) {
  return deterministic(computeCadenceMetrics(videos));
}
