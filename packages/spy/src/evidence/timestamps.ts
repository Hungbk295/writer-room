import type { SamplingPolicy } from '../schema.ts';

const roundMillis = (value: number): number => Math.round(value * 1000) / 1000;

export function spreadTimestamps(durationSec: number, count: number): number[] {
  if (durationSec <= 0 || count <= 0) return [];
  if (count === 1) return [roundMillis(durationSec * 0.05)];
  const low = Math.min(durationSec * 0.02, 1);
  const high = Math.max(low, durationSec - Math.max(0.25, durationSec * 0.02));
  const step = (high - low) / (count - 1);
  return [...new Set(Array.from({ length: count }, (_, index) => roundMillis(low + step * index)))];
}

export function sequentialTimestamps(durationSec: number, count: number, intervalSec: number): number[] {
  if (durationSec <= 0 || count <= 0) return [];
  const values: number[] = [];
  for (let timestamp = 0; timestamp < durationSec && values.length < count; timestamp += intervalSec) {
    values.push(roundMillis(timestamp));
  }
  return values;
}

export function randomTimestamps(
  durationSec: number,
  count: number,
  random: () => number = Math.random,
): number[] {
  if (durationSec <= 0 || count <= 0) return [];
  const low = durationSec * 0.02;
  const high = durationSec * 0.98;
  const minimumGap = Math.max(0.5, (high - low) / Math.max(1, count * 4));
  const values: number[] = [];
  for (let attempt = 0; attempt < count * 50 && values.length < count; attempt++) {
    const candidate = roundMillis(low + random() * (high - low));
    if (values.every((value) => Math.abs(value - candidate) >= minimumGap)) values.push(candidate);
  }
  return values.length === count ? values.toSorted((a, b) => a - b) : spreadTimestamps(durationSec, count);
}

export function samplingTimestamps(
  durationSec: number,
  policy: SamplingPolicy,
  random: () => number = Math.random,
): number[] {
  switch (policy.mode) {
    case 'sequential':
      return sequentialTimestamps(durationSec, policy.frameCount, policy.intervalSec);
    case 'random':
      return randomTimestamps(durationSec, policy.frameCount, random);
    case 'scene':
    case 'spread':
      return spreadTimestamps(durationSec, policy.frameCount);
  }
}

export function coverageBuckets(durationSec: number, timestamps: readonly number[]): Set<string> {
  const buckets = new Set<string>();
  if (durationSec <= 0) return buckets;
  for (const timestamp of timestamps) {
    const ratio = timestamp / durationSec;
    if (ratio < 0.15) buckets.add('opening');
    else if (ratio < 0.4) buckets.add('early');
    else if (ratio < 0.65) buckets.add('middle');
    else if (ratio < 0.85) buckets.add('late');
    else buckets.add('ending');
  }
  return buckets;
}
