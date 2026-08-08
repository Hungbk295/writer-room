export type AgeCohort = '0-30d' | '30-90d' | '90-365d' | '>365d';

const MS_PER_DAY = 86_400_000;

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
  }
  return sorted[mid]!;
}

/** Linear-interpolation percentile on sorted data (p in 0–100). */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  if (values.length === 1) return values[0]!;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sorted[lower]!;
  const weight = rank - lower;
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
}

/** Median absolute deviation — robust spread measure. */
export function mad(values: number[]): number {
  if (values.length === 0) return 0;
  const med = median(values);
  const deviations = values.map((v) => Math.abs(v - med));
  return median(deviations);
}

/** Modified z-score using MAD; 1.4826 scales MAD to stddev-equivalent. */
export function outlierScore(value: number, med: number, madValue: number): number {
  if (madValue === 0) return value === med ? 0 : value > med ? Infinity : -Infinity;
  return (value - med) / (1.4826 * madValue);
}

export function ageInDays(publishedAt: Date, referenceDate: Date = new Date()): number {
  const published = publishedAt instanceof Date ? publishedAt : new Date(publishedAt);
  return Math.max(0, (referenceDate.getTime() - published.getTime()) / MS_PER_DAY);
}

export function ageCohort(publishedAt: Date | string, referenceDate: Date = new Date()): AgeCohort {
  const days = ageInDays(
    publishedAt instanceof Date ? publishedAt : new Date(publishedAt),
    referenceDate,
  );
  if (days <= 30) return '0-30d';
  if (days <= 90) return '30-90d';
  if (days <= 365) return '90-365d';
  return '>365d';
}

export function velocity(viewCount: number, publishedAt: Date | string, referenceDate: Date = new Date()): number {
  const days = Math.max(1, ageInDays(
    publishedAt instanceof Date ? publishedAt : new Date(publishedAt),
    referenceDate,
  ));
  return viewCount / days;
}
